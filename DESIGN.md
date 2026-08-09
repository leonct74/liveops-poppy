# DESIGN.md — LiveOpsPoppy (working name)

Source of truth for **LiveOpsPoppy**: a game-backend poppy — remote config (LiveOps) +
privacy-sane player telemetry — that runs **entirely in the game developer's own AWS
account**. An AgentsPoppy extension built to the framework (`~/Projects/agentspoppy/AGENTS.md`
+ `docs/INTEGRATION.md`). This doc records decisions and rationale; update it whenever a
decision changes.

> **Boundary:** LiveOpsPoppy is a standalone project. It runs *on* AgentsPoppy — it does not
> fork or clone it. It never touches the mailpoppy, traffic-poppy, or vm-poppy repos, but it
> deliberately **reuses their proven patterns** (§8).

> **Status: DRAFT — awaiting founder review of the open questions (§12). No code exists.**

---

## 1. What it is — and why it beats the game-BaaS class

One-click deploys a **serverless game backend** into the developer's AWS: a remote-config
plane (change game balance, store prices, feature toggles, event schedules — without a new
build through Steam/Apple review) and a telemetry plane (DAU, sessions, retention, custom
events). The poppy's screen in AgentsPoppy is the dashboard and the config editor. Positioning
against PlayFab / Unity Gaming Services / Firebase / GameAnalytics:

1. **No per-MAU meter, ever.** The BaaS class prices per player or per event — success is
   punished. LiveOpsPoppy is a flat subscription + the developer's own AWS bill (a few
   dollars/month at 10k DAU, pennies below that; §10). A hit game costs the same license fee
   as a prototype.
2. **The platform cannot rug-pull you, because there is no platform in the data path.** Unity's
   2023 runtime-fee reversal taught every studio that a vendor can reprice shipped games
   retroactively. Here the "vendor" is a CloudFormation stack the developer owns. If Olly
   Digital vanished tomorrow, every deployed backend keeps running unchanged.
3. **The player data belongs to the studio.** GameAnalytics is free *because* the data flows
   through their cloud. LiveOpsPoppy's telemetry lands in the developer's own DynamoDB/S3 in a
   documented schema — Athena/QuickSight/any BI tool plugs in (same open-surface rule as
   TrafficPoppy §1.4).
4. **Self-hosting without servers.** Nakama proves studios want to self-host, but it demands a
   VM + database running 24/7 and someone to operate them. A poppy is serverless self-hosting:
   ~$0 at idle, no patching, one-click teardown (`certify`-verified).
5. **Ship-without-review velocity.** Remote config is the single highest-leverage LiveOps tool
   for a small studio: nerf a weapon, extend an event, fix a broken price — live in seconds,
   no store review, instant rollback.

**Why this audience is strategically right for AgentsPoppy now:** game developers are
*developers* — they already clear the AWS-account obstacle that blocks consumer conversion;
they culturally accept "own your infra" (they buy Unity assets, self-host Nakama); and they
live in dense, viral communities (r/gamedev, itch.io, Godot forums, devlogs, GDC). Every
LiveOpsPoppy studio is a flywheel node.

**Non-goals (v1 and mostly forever):** multiplayer netcode, matchmaking, lobbies, voice,
ad mediation, push notifications, IAP receipt validation, session replay, user-level ad
profiles. **Cloud saves and leaderboards are v2, not v1** (§11a) — they are the hardest
features dressed up as easy (durability expectations + real account auth), and v1 must not
carry their risk.

## 2. Product scope

### v1 — the wedge
- **Remote config**: per-title, per-environment (`dev`/`prod`) JSON documents, versioned,
  publish + one-click rollback, served to game clients over HTTPS with cache headers.
- **Telemetry**: session counts + length, DAU, D1/D7/D30 retention cohorts, custom events
  (name + optional numeric value), platform and app-version breakdowns.
- **Protection**: per-title daily event cap (the bill-protection guarantee, §5), event
  cardinality guard, in-app usage/cost display (AGENTS.md §9 "Show the money").
- **SDK**: ONE dependency-free C# file for Unity (§4) + documented plain REST for everyone
  else. No SDK farm.

### v2 — after v1 revenue proves the vertical
- **Cloud saves**: per-player key-value/blob saves; auth via Steam session-ticket verification
  and Apple/Google sign-in verification (server-side), device-bound anonymous as the floor;
  last-write-wins first, smarter merge later.
- **Leaderboards**: per-board top-N maintained on write (bounded item), not full sorted scans.
- CloudFront + custom domain in front of the endpoints for big titles; percentage rollouts /
  A-B config segments; Godot + Unreal SDK snippets (unless pulled into v1 — §12).

## 3. Architecture (serverless, one CloudFormation stack)

```
game client ── GET /config/{titleId}/{env} ─► edge Lambda (Function URL)
     │              (If-None-Match / 304)         │ in-memory cache, ~60 s
     └── POST /e  {titleKey, batch[≤25]} ────────►│ validate key → cap check →
                                                  ▼
                                DynamoDB `liveops` table (on-demand)
                                  config:   title#<id>#config#<env>  sk v#<n> + current ptr
                                  counters: title#<id>#day#<date>    sk event#/sess#/plat#…
                                  players:  title#<id>#player#<h>    {firstSeen,lastSeen}
                                  cohorts:  title#<id>#cohort#<date> sk d1/d7/d30
                                                  │
   AgentsPoppy poppy UI (dashboard+editor) ◄── sidecar backend ── Query (scoped creds)
   studio's BI tools ◄── documented schema / read API (token, post-MVP) ──┘
                             (optional, default OFF) S3 raw NDJSON, 30-day lifecycle → Athena
```

- **One Lambda with a Function URL** serves both planes (config GET, events POST) — the
  TrafficPoppy decision, for the same reasons: no API Gateway cost/moving parts, no CloudFront
  in MVP. Config responses carry `ETag` + `Cache-Control`; the SDK revalidates cheaply.
- **Config = pointer flip.** Each publish writes an immutable `v#<n>` item and flips the
  `current` pointer. Rollback = flip the pointer back. The UI shows the version history with
  diffs. Config documents are capped (64 KB) — DynamoDB item limit is 400 KB; games needing
  more get an S3-backed variant post-MVP.
- **Aggregates-first storage** (TrafficPoppy single-table pattern): dashboard reads are a
  handful of Queries over `title#<id>#day#<date>` counter items (atomic `ADD`). Raw events are
  **optional and default OFF**; when enabled they batch to S3 as NDJSON with a 30-day
  lifecycle rule (Athena opt-in later — the MailPoppy deep-search pattern).
- **Retention needs cross-day identity — say so honestly.** Unlike web analytics, D1/D7/D30
  retention is *the* core game metric and cannot be computed from daily-salted hashes. The SDK
  generates a random install id (UUID, no device fingerprinting); the Lambda stores only
  `sha256(titleSalt + installId)` with a **per-title stable salt**. That is pseudonymous, not
  anonymous — the privacy posture (§6) is built on pseudonymisation + deletion + expiry, not
  on TrafficPoppy's stronger "cryptographically unlinkable" claim. Never copy TrafficPoppy's
  privacy copy into this poppy.
- **Retention computed on write, not by jobs:** on `session_start`, if `daysSince(firstSeen)`
  ∈ {1,7,30}, increment the matching `cohort#<firstSeenDate>` counter once (conditional flag
  on the player item). No schedulers, no scans.
- **Sidecar backend** = the MailPoppy/TrafficPoppy pipeline: embedded asset-free template +
  Lambda zip (`backend-bundle` approach), deploy/update via CloudFormation, teardown +
  `certify`. **Template is hand-authored TypeScript** (TrafficPoppy P0 decision), not cdk —
  the footprint is one table, one Lambda, one role, one optional S3 bucket.

## 4. The client SDK — one file, not a farm

The honest cost of this vertical is SDK maintenance (PlayFab's real moat). v1 refuses the
treadmill:

- **`LiveOpsPoppy.cs`** — a single dependency-free C# file generated in-app with the endpoint
  + title key baked in ("Export for Unity" button; VM-Poppy CopyButton pattern). It does:
  config fetch on boot + interval with ETag revalidation and a cached-last-good fallback
  (**the game must boot fine fully offline**); an event queue with local persistence, batching
  (≤25/request), flush on interval + `OnApplicationPause`, exponential backoff; automatic
  `session_start`/`session_end`, platform, app version. Nothing else.
- **Plain REST is a first-class citizen**: two endpoints, documented with curl examples —
  an Unreal/Godot/custom-engine dev integrates in an afternoon without us shipping their SDK.
- **Godot GDScript snippet**: cheap to write and culturally the best-aligned community
  (anti-subscription, pro-ownership) — founder call whether it's v1 or v1.1 (§12).
- Engine SDKs beyond that are **explicitly post-revenue**.

## 5. Abuse & bill protection (security-critical, designed first)

Every player effectively holds credentials to an endpoint that writes to the developer's AWS
bill. The title key ships inside the game binary, so **assume it is public** (every game
analytics product lives with this).

- **The per-title daily event cap is the load-bearing guarantee**: an atomic daily counter;
  over cap → drop with 429 + one in-app alert. Default 500k events/day (knob in Settings).
  This converts "hostile player scripts my endpoint" from an unbounded bill into a bounded,
  stated worst case (§10 shows the math). The cap check costs one `ADD` that was being paid
  anyway (the `total#events` counter doubles as the cap counter).
- **Cardinality guard**: event names validated (`[a-z0-9_]{1,64}`), max distinct event-name
  counters per title per day (default 200); overflow lands in an `event#__other` bucket — a
  griefer cannot explode the table with random names.
- **Config plane is read-only and cacheable** — worst case is Lambda invocations, bounded by
  in-memory caching + 304s; CloudFront for the truly paranoid/big is v2.
- **Billing honesty rule**: AWS billing metrics lag hours. The UI says "daily event cap"
  (enforced, real-time) and "estimated cost" (computed from our own counters, real-time) —
  never "spending cap." No claim the stack can't cash.
- WAF requires CloudFront/API GW, so it arrives with the v2 CloudFront option, stated as such.

## 6. Privacy & GDPR posture

- **Pseudonymous by construction**: random install id (no IDFA/ad-id, no fingerprinting),
  hashed with a per-title salt at ingestion; IP used transiently, never stored. COPPA note in
  docs: with no ad identifiers and no behavioral profiles, the poppy avoids the worst of it,
  but age-gating is the studio's responsibility — guidance, not legal advice (the
  AdminPrivacyNotice tone from MailPoppy).
- **"Delete this player" is designed-in, not bolted on** (the data model makes it cheap):
  given an install id from a player's support request, delete the `player#<hash>` item and
  their saves (v2). Aggregate counters contain no per-player data and are untouched — that is
  the *reason* for aggregates-first. Raw NDJSON (if enabled) auto-expires in 30 days, so the
  honest answer for the archive is "expires within 30 days," not a fake instant purge of
  immutable S3 objects.
- **Retention windows**: player rows carry a TTL refreshed on activity (default: expire after
  ~13 months of inactivity); counters are the studio's own data, kept indefinitely.
- The catalogue **data-flow declaration is trivially clean**: no data leaves the user's cloud;
  qualifies for the "Data stays in your cloud" label.

## 7. Dashboard (MVP screens)

1. **Overview** — DAU sparkline, sessions, avg session length, D1/D7/D30 retention, platform
   + app-version split, cost line ("Show the money").
2. **Events** — top custom events, per-event daily counts, the `__other` overflow indicator.
3. **Remote config** — per-title/env JSON editor with validation, publish (inline confirm),
   version history with rollback, "what the client sees" preview + curl.
4. **Titles & SDK** — create title, key management (rotate = new key, old key grace window),
   "Export for Unity" / REST snippet with copy buttons.
5. **Settings** — event cap, cardinality cap, raw-archive toggle (default OFF, cost stated),
   alert webhook (Discord/Slack URL) for cap-hit and error-rate alerts (§12).
6. **AWS Resources** — the mandatory transparency view (MailPoppy §14.1 class) + teardown.

## 8. Reuse from the existing poppies (do NOT reinvent)

| Piece | Source |
|---|---|
| Single-table counters + Query-based dashboard | TrafficPoppy data model |
| Function URL collector, no API GW/CloudFront in MVP | TrafficPoppy §2 |
| Hand-authored TS template + embedded backend bundle + deploy/teardown/certify | TrafficPoppy P0 / MailPoppy pipeline |
| Copy-button snippet UX | VM-Poppy |
| Settings-table policy docs, fail-safe normalizers | MailPoppy `core/policy.ts` pattern |
| Idempotency rule (deterministic sort keys, never `new Date()` fallbacks) | MailPoppy migration bug |
| "Show the money" cost line | AGENTS.md §9, TrafficPoppy reference impl |

## 9. Permission set & rating (eyes open)

Same class as TrafficPoppy: a CloudFormation stack containing a Lambda ⇒ an execution role ⇒
cannot be IAM-free ⇒ expect **amber**. Services: CloudFormation, Lambda (+role), DynamoDB,
S3 (deploy bucket + optional raw bucket), Logs. **No Cognito in v1** (players are not Cognito
users; there is no human login to the backend) — fewer services than MailPoppy. v2 saves add
either Cognito or Lambda-signed player tokens (decide then; leaning tokens to stay lean).
Remember the risk-assessor substring trap — verify the rating with the real assessor, not by
reading the matrix.

## 10. Pricing & competition (the page-6 story)

**Subscription per studio, ~$79/yr** through the AgentsPoppy checkout (5% platform fee;
founder to confirm unit + price — §12). Never per-MAU, never per-event; that inversion *is*
the marketing. The retired "pay once" framing stays retired.

Cost math shown in-app and in the listing (worst-case honest): 10k DAU × ~50 events/day
= 15M events/mo, batched ≤25 ⇒ ~600k Lambda requests (inside free tier), ~2–4M DynamoDB
writes ⇒ **roughly $3–6/mo of AWS at 10k DAU; pennies for a small title; ~$0 idle.**

| | LiveOpsPoppy | PlayFab | Unity Gaming Services | GameAnalytics | Nakama (self-host) |
|---|---|---|---|---|---|
| Pricing model | flat/yr + own AWS | per-MAU tiers | free tiers → usage | "free" | free + your servers |
| 10k DAU cost | ~$79/yr + ~$5/mo AWS | grows with MAU | grows with usage | $0 | VPS + DB 24/7 + ops |
| Who holds player data | the studio | Microsoft | Unity | GameAnalytics | the studio |
| Can vendor reprice shipped games | no — no vendor in path | yes | proven (2023) | yes (data terms) | no |
| Servers to operate | none | none | none | none | yes |

(List prices are moving targets — re-check before any public table, per the pitch-doc rule.)

## 11. Adjacent poppies this design unlocks

- **11a. v2 saves + leaderboards** — same stack, new tables; the risky half deliberately
  deferred until the wedge earns it.
- **11b. FlagPoppy (separate listing, later)** — strip the games skin off the config plane and
  it's **feature flags for all software teams** (LaunchDarkly charges per seat; the infra is a
  table + a Lambda). Bigger market than games, shares the config-plane code. Park until
  LiveOpsPoppy ships; recorded here so the config plane is written as a reusable module.

## 12. Open questions (founder — resolve before coding)

1. **Name — DECIDED (founder, 2026-08-09): `LiveOpsPoppy`.** Rationale: "LiveOps" is the
   term game developers themselves use — clearer *to the target audience* than a generic
   "game" name, even though outsiders won't parse it. (The earlier "games-only ⇒ 'game' in
   the name" criterion was superseded by this audience-clarity argument.)
2. **Pricing unit**: per-studio unlimited (~$79–99/yr) vs per-title (~$49/yr)? Recommend
   per-studio — simpler, and "unlimited titles" rhymes with MailPoppy's "unlimited mailboxes."
3. **Godot snippet in v1?** Cheap, and the Godot crowd is the most ownership-aligned audience.
4. **Raw S3 archive**: default OFF (recommended) — confirm.
5. **Alert webhooks (Discord/Slack) in v1** or v1.1?
6. **Who builds it**: first-party (like the other five) or the flagship seeded third-party
   case study? First-party keeps quality control; third-party proves the developer story.
7. **Priority**: does this jump ahead of the parked candidates (blockchain/escrow) and the
   current marketing focus? It *is* partly a marketing answer (an audience that clears the
   AWS obstacle), but it's still a multi-week build.

## 13. Development plan (phased; each phase ends green: typecheck + tests + certify where it applies)

- **P0 — skeleton + config plane**: repo scaffold (npm workspaces: `core`, `backend`,
  `frontend`, `infra`, `node-sidecar` — the TrafficPoppy layout), hand-authored template
  (table + Lambda + Function URL + role), deploy/teardown via sidecar, config CRUD + versioned
  publish/rollback end-to-end, `certify` clean.
- **P1 — telemetry**: `POST /e` validate/cap/aggregate, player first-seen/retention cohorts,
  dashboard screens 1–2, cost line.
- **P2 — SDK + docs**: `LiveOpsPoppy.cs` generator + REST docs + (if v1) Godot snippet;
  a sample Unity scene as the test rig.
- **P3 — hardening + listing**: cardinality guard, key rotation, alert webhook, data-flow
  declaration, screenshots, catalogue submission.
- **v2** — saves (Steam/Apple verification), leaderboards, CloudFront option, rollout
  percentages.

## 14. Status

- 2026-08-09 — first draft written from the founder's LiveOpsPoppy concept discussion.
  Scope decision proposed: remote config + telemetry wedge first, saves v2, one-file Unity
  SDK. Awaiting founder review of §12.
- 2026-08-09 — **name locked: LiveOpsPoppy** (founder). Detailed build plan written:
  **`IMPLEMENTATION.md`** (repo layout, manifest grants, table/key contract, endpoint
  contracts, SDK spec, phases P0–P6 with done-gates). Working assumptions A1–A5 recorded
  there for founder veto; remaining §12 questions folded into them. No code yet.
