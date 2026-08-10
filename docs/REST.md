# The LiveOpsPoppy wire contract

Two endpoints, plain HTTPS, no SDK required. The generated `LiveOps.cs` is a convenience
for Unity; **this document is the actual product surface**, and Unreal, Godot, a custom
engine or a server-side tool integrates from it alone.

Both endpoints live on the collector Lambda's Function URL, which the poppy shows you after
deployment:

```
https://<id>.lambda-url.<region>.on.aws
```

That address, and the per-title key, are the only two things your game needs.

---

## Authentication, and what the key is not

Every request carries the **title key** — `?k=` on config reads, `"k"` in the events body.

The key ships inside your game binary, so treat it as **public**. It is a routing and
abuse-control credential, not a secret: it identifies which title's counters to move and
lets you cut off a leaked build by rotating it. It grants no read access to your dashboard,
your AWS account, or another title's data.

That assumption is why the backend has a per-title daily event cap (below) rather than
trusting the caller.

Keys are shown **once**, at creation; the backend stores only a SHA-256 hash. Rotating a key
keeps the previous one working for a grace window so a released build is never bricked
mid-rotation.

---

## `GET /config/{titleId}/{env}`

Returns the published config document for one environment.

| | |
|---|---|
| **Path** | `titleId` matches `[a-z0-9]{4,32}`; `env` is `dev` or `prod` |
| **Query** | `k` — the title key (required) |
| **Request header** | `If-None-Match: "v7"` — optional, and worth sending every time |

### Responses

**`200`** — the current document.

```json
{ "v": 7, "config": { "balance": { "shotgunDamage": 32 }, "shop": { "starterBundlePrice": 4.99 } } }
```

Response headers:

```
ETag: "v7"
Cache-Control: public, max-age=60
```

**`304 Not Modified`** — the version you already hold is current. Empty body, same cache
headers. Send `If-None-Match` with the last `ETag` you saw and most polls cost you one
near-empty response instead of the whole document.

**`403`** — `{"error":"Unknown title or bad key."}`. Deliberately the same answer for an
unknown title and a wrong key, so title ids cannot be enumerated.

**`404`** — malformed `titleId` or an `env` that is not `dev`/`prod`.

### Two behaviours to build around

- **An unpublished environment returns `{"v":0,"config":{}}`, not an error.** A game must
  never fail to boot because the studio has not published yet. Every lookup you do should
  carry an in-code default, and that default is what a fresh install uses.
- **`Cache-Control: max-age=60`** is the honest refresh horizon. Polling harder does not get
  you a faster rollout; the reference SDK re-checks every 5 minutes, which is what "publish
  a change and see it live in minutes" means in practice.

---

## `POST /e`

Submits a batch of events for one session.

```
Content-Type: application/json
```

```json
{
  "t": "abcd1234",
  "k": "<title key>",
  "s": { "iid": "9f2c1a44-...", "sid": "a1b2c3d4e5f60718", "plat": "windows", "ver": "1.4.0" },
  "e": [
    { "n": "session_start" },
    { "n": "level_complete", "v": 3 },
    { "n": "session_end", "v": 412 }
  ]
}
```

### Fields

| Field | Rule |
|---|---|
| `t` | title id, `[a-z0-9]{4,32}` |
| `k` | title key, 8–128 characters |
| `s.iid` | **install id** — 8–64 chars of `[A-Za-z0-9-]`. Generate a random UUID on first run and persist it. See *Identity* below. |
| `s.sid` | session id, 4–64 chars. Fresh per boot; used only to group a session. |
| `s.plat` | free text — lowercased and stripped to `[a-z0-9._-]`, truncated to 32 chars, `"unknown"` if empty. Never rejected. |
| `s.ver` | your game's version string, sanitised the same way |
| `e` | 1–25 events |
| `e[].n` | event name, `[a-z0-9_]{1,64}` |
| `e[].v` | optional finite number |

Whole body: **32 KiB maximum**.

### Reserved event names

| Name | Meaning |
|---|---|
| `session_start` | Counts the session, and feeds the platform/version split, DAU and the retention cohorts. Send exactly one per boot. |
| `session_end` | `v` is the **session length in seconds**. Session count and average length are both derived from this event, so they always divide consistent units. |

Everything else is yours.

### Responses

| Status | Body | What to do |
|---|---|---|
| `202` | `{"ok":true,"accepted":3}` | Done. Drop the batch from your queue. |
| `400` | `{"error":"..."}` | The request is wrong — a bad name, a non-finite value, a malformed id. **Do not retry**; the error text names the field. |
| `403` | `{"error":"Unknown title or bad key."}` | Wrong key or unknown title. Do not retry. |
| `413` | `{"error":"Body too large."}` | Split the batch. |
| `429` | `{"error":"Daily event cap reached for this title.","retryAfter":18240}` + `Retry-After` header | **Stop sending until the cap resets** (see below). |
| `500` | `{"error":"Internal error."}` | Transient. Re-queue and retry with backoff. |

---

## The daily event cap — the one behaviour you must handle

The key is public, so the backend assumes it will eventually be abused. Each title has a
**daily event cap** (500,000/day by default, adjustable in the poppy) enforced in real time,
before any of the per-event work happens. Past it, `POST /e` returns `429` until 00:00 UTC.

`retryAfter` is the number of seconds until that reset, and the `Retry-After` header carries
the same value.

**Correct client behaviour on `429` is to drop the batch, not to retry it.** Retrying into a
cap cannot deliver the events and can only add requests to a bill that is already the reason
the cap exists. The reference SDK drops; so should yours.

This is the deliberate trade in the design: an attacker with your key can exhaust one title's
daily telemetry allowance and distort a day of your numbers. They cannot make your AWS bill
unbounded, which is the failure that actually hurts.

A second, softer guard applies to **event-name cardinality**: past roughly 200 distinct
custom names in a day, further new names are folded into a single `__other` bucket rather
than creating unbounded counters. The dashboard says so when it happens. Names come from
your code, so this only fires if a name is being built from a variable — which is the bug it
exists to contain.

---

## Identity — what `iid` is, precisely

Do **not** send a device id, an advertising id, an IDFA/GAID, an email, or an account id.
Generate a random UUID on first launch, persist it, and send that.

The backend never stores it. It stores `sha256(per-title-salt + iid)`, and the salt lives
only in your own DynamoDB table.

This is **pseudonymous, not anonymous**, and the docs say so on purpose: the hash is stable
across days, which is exactly what makes D1/D7/D30 retention possible. Treat it as personal
data in your privacy policy. Hash rows for daily-unique counting expire after 40 days and
player rows after ~13 months of inactivity; the poppy also has a per-player erasure tool for
a deletion request.

---

## A minimal integration

Three calls is a complete one.

```bash
BASE="https://<id>.lambda-url.<region>.on.aws"
TITLE="abcd1234"
KEY="<title key>"

# 1. Boot: read config. Keep the ETag.
curl -i "$BASE/config/$TITLE/prod?k=$KEY"

# 2. Later: revalidate cheaply.
curl -i -H 'If-None-Match: "v7"' "$BASE/config/$TITLE/prod?k=$KEY"

# 3. Send a session.
curl -i -X POST "$BASE/e" -H 'content-type: application/json' -d '{
  "t": "'"$TITLE"'", "k": "'"$KEY"'",
  "s": {"iid":"11111111-2222-3333-4444-555555555555","sid":"boot0001","plat":"linux","ver":"1.0.0"},
  "e": [{"n":"session_start"},{"n":"level_complete","v":1},{"n":"session_end","v":95}]
}'
```

`scripts/simulate-game.mjs` in this repo does the same thing with realistic traffic —
including a `--flood` mode that drives a title into the cap so you can watch the `429`
before a real player ever does.

---

## Porting checklist

A client is finished when all of these hold:

- [ ] Every config lookup has an in-code default, and the game boots with the backend
      unreachable.
- [ ] The last good config document is cached on disk and loaded at startup.
- [ ] `If-None-Match` is sent on every config read after the first.
- [ ] Events are queued, batched at ≤25, and the queue is bounded (drop oldest).
- [ ] The queue survives a background/quit.
- [ ] `429` and any other `4xx` drop the batch; `5xx` and network errors re-queue.
- [ ] `session_start` is sent once per boot, `session_end` carries seconds.
- [ ] `iid` is a persisted random UUID — nothing device-derived.
