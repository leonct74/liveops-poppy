# IMPLEMENTATION.md — LiveOpsPoppy

Detailed build plan for the design in `DESIGN.md`. **Name locked (founder, 2026-08-09):
LiveOpsPoppy.** The reference codebase is `~/Projects/traffic-poppy` — same workspace layout,
same build pipeline, same manifest shape; steal structure shamelessly, never code that
carries TrafficPoppy's privacy claims (DESIGN §3: this poppy is pseudonymous, not anonymous).

## Working assumptions (founder can veto any of these; they unblock the plan)

| # | Assumption | Source |
|---|---|---|
| A1 | Pricing: per-studio subscription **$79/yr**, AgentsPoppy first-party checkout | DESIGN §10 recommendation |
| A2 | Raw S3 event archive is **not in v1 at all** (not even a toggle) — aggregates only. Cuts an S3 bucket + lifecycle + grants from the stack and the manifest | simplification of DESIGN §12.4 |
| A3 | Godot snippet + alert webhooks land in **v1.1**, not v1.0 | DESIGN §12.3/§12.5 |
| A4 | Built **first-party** (Olly Digital), like the other five poppies | DESIGN §12.6 |
| A5 | Environments fixed at `dev` + `prod` in v1 (no custom env names) | scope control |

## 0. Repo & packaging (mirror TrafficPoppy exactly)

- Repo `~/Projects/liveops-poppy`, npm workspaces: `infra`, `lambdas`, `backend`, `frontend`
  (+ non-workspace `shared/src` for cross-imports, as TrafficPoppy does).
- Root `package.json`: `license: "PolyForm-Shield-1.0.0"`, scripts copied from TrafficPoppy —
  `typecheck`, `test`, `gen:backend` (build-backend-bundle.mjs), `build`,
  `validate-manifest`, `sync-feedback`/`check-feedback` (the **mandatory Feedback tab**,
  vendored to `frontend/src/vendor/`), `pack`, `install-dev`, `certify` — all deferring to
  `${AGENTSPOPPY_REPO:-../agentspoppy}` scripts. **No SEA anywhere** (node22 rule R1):
  package platform-`any`, backend entry `backend/index.cjs`.
- `extension.json`: `id: "com.liveopspoppy.desktop"`, `backend.runtime: "node22"`,
  `teardown.endpoint: "/teardown"`, capabilities
  `aws:credentials, connection:read, backend:invoke, commerce:purchase, host:openExternal`.
- Scripts `build-backend-bundle.mjs` / `build-backend.mjs` / `deterministic-zip.mjs` /
  `validate-manifest.mjs` / `make-icon.mjs`: copy from traffic-poppy, rename. Same trap
  applies: **any lambdas/ or infra/ change requires `npm run gen:backend`** before the
  running app can deploy it — document in CLAUDE.md from day one.

## 1. Manifest permission set (draft — run the REAL risk assessor before trusting a rating)

Strictly smaller than TrafficPoppy's (no Cognito, no ACM, no CloudFront, no S3 beyond the
deploy bucket):

| service | actions (TrafficPoppy's list, same names) | resourceScope |
|---|---|---|
| cloudformation | Create/Update/Delete/Describe* + ContinueUpdateRollback | `arn:aws:cloudformation:*:*:stack/LiveOpsPoppy*` |
| dynamodb | table lifecycle + TTL + tags + Query/Get/Put/Update/Delete | `arn:aws:dynamodb:*:*:table/LiveOpsPoppy*` |
| lambda | function lifecycle + FunctionUrlConfig + Add/RemovePermission + tags | `arn:aws:lambda:*:*:function:LiveOpsPoppy*` |
| iam | role lifecycle + PassRole + inline policy + tags | `arn:aws:iam::*:role/LiveOpsPoppy*` |
| logs | log-group lifecycle + retention + tags | `arn:aws:logs:*:*:log-group:/aws/lambda/LiveOpsPoppy*` |
| s3 | bucket lifecycle + object Put/Get/Delete | `arn:aws:s3:::liveopspoppy-deploy-*` |

Description written in plain language (the CrewPoppy manifest precedent): "Deploys and
removes its own CloudFormation stack (LiveOpsPoppyStack): one DynamoDB table, one collector
Lambda behind a public URL, and that Lambda's least-privilege role. Cannot touch anything
not named LiveOpsPoppy*."

## 2. The stack (`infra/src/template.ts` — pure TS builder + unit tests)

Resources (all named `LiveOpsPoppy*`, all carrying the three `agentspoppy:*` required tags):

1. `LiveOpsPoppyData` — DynamoDB on-demand, `pk`/`sk` strings, TTL attribute `expiresAt`
   (TrafficPoppy's convention).
2. `LiveOpsPoppyCollector` — node22 Lambda, 256 MB, env `TABLE_NAME`; code via
   `LambdaCodeBucket`/`LambdaCodeKey` CFN params (asset-free, the proven pattern).
3. Function URL (auth NONE) + `AddPermission` for public invoke.
4. Execution role: logs + DynamoDB `Query/GetItem/PutItem/UpdateItem/DeleteItem`
   **on the one table only**.
5. Log group with 30-day retention.

Outputs: `CollectorUrl`, `TableName`, `TableArn`, `TemplateRevision` (monotonic marker for
update-available checks — **ordering-aware from day one**; MailPoppy's plain inequality
check produced the 07-29 downgrade footgun).

## 3. Data model (single table — every key literal below is the contract; core tests lock them)

```
titles     pk=title#<titleId>                sk=meta        {name, keyHash, createdAt, eventCap, cardCap}
config     pk=cfg#<titleId>#<env>            sk=v#<000042>  {json, publishedAt, note}   (immutable)
config ptr pk=cfg#<titleId>#<env>            sk=current     {version}                   (flip = publish/rollback)
counters   pk=day#<titleId>#<YYYY-MM-DD>     sk=total#events | event#<name> | event#__other
                                             | sess#count | sess#seconds | plat#<p> | ver#<v> | dau
uniques    pk=uniq#<titleId>#<YYYY-MM-DD>    sk=<playerHash>   (conditional put; TTL ~40d;
                                                success ⇒ ADD dau 1)
players    pk=player#<titleId>               sk=<playerHash>  {firstSeen, lastSeen, d1, d7, d30}
                                                (TTL refreshed on activity, ~13 months)
cohorts    pk=cohort#<titleId>#<firstSeen>   sk=size | d1 | d7 | d30
```

- `titleId` = 8-char random base32 (no meaning, no PII). `playerHash` =
  `sha256(titleSalt + installId)` where `titleSalt` lives on the title meta item.
- `keyHash`: the title key is shown once at creation, stored **hashed** (sha256) — same
  posture as any API-key system; rotation writes `keyHash2` with a 7-day grace, then swaps.
- Retention increments: on session_start, if player item's `d1/d7/d30` flag unset and
  `daysSince(firstSeen)` ≥ threshold bucket, set flag + `ADD cohort.dN 1` in one
  UpdateItem with a condition — idempotent under retries. **Deterministic keys only; the
  MailPoppy importer rule applies: never `new Date()` as a data-affecting fallback** —
  event timestamps default to *server* receive time, truncated to the day, passed down
  explicitly.

## 4. Collector Lambda (`lambdas/src/`)

Files mirror TrafficPoppy: `core.ts` (pure logic — ALL of it unit-tested), `store.ts`
(DynamoDB thin layer), `collector.ts` (routing + handler).

**`GET /config/{titleId}/{env}?k=<titleKey>`**
- key check (hash compare, both hashes during grace) → 403 on miss.
- Reads pointer + version (module-level cache, 60 s). Response `{v, config}` with
  `ETag: "v42"`, `Cache-Control: public, max-age=60`; `If-None-Match` hit → 304 (no body —
  this is what makes millions of boots cost pennies).
- Missing config (never published) → 200 `{v:0, config:{}}` — **a game must never break
  because the studio hasn't published yet.**

**`POST /e`**  body `{t, k, s:{iid, sid, plat, ver}, e:[{n, v?, ts?} ×≤25]}`
- Validate: key; batch ≤25; `n` matches `[a-z0-9_]{1,64}`; sizes capped (body ≤ 32 KB).
- **Cap gate first**: `ADD total#events N` returns the new value; if > `eventCap` → drop
  batch, 429 `{retryAfter}` (the SDK backs off for the rest of the UTC day). The counter
  that enforces the cap is the same counter the dashboard reads — no extra cost.
- Cardinality: `event#<name>` counters guarded by a per-day distinct-names counter item;
  over `cardCap` (default 200) → route to `event#__other`.
- Session accounting: `session_start` ⇒ uniq conditional-put (dau), player first/last-seen +
  retention flags (§3); `session_end {v:seconds}` ⇒ `ADD sess#count 1, sess#seconds v`.
- Always 202 on accepted (fire-and-forget from the game's perspective); never leak internal
  errors to the public endpoint.

## 5. Sidecar backend (`backend/src/`)

Copy the TrafficPoppy skeleton: `boot.ts` (broker handshake), `server.ts` (HTTP routes),
`stack.ts` (deploy/update/status via inline TemplateBody until the Lambda zip forces the
deploy bucket — it does here from v1, so `deploy-bucket.ts` comes too), `tags.ts`. New
modules:

- `titles.ts` — create (generates titleId + key + salt; returns key ONCE), list, rename,
  rotate-key, set caps, delete (+ its rows: bounded Query+BatchWrite sweep).
- `config.ts` — get current + history (last 20), validate JSON (≤64 KB, must be an object),
  publish (write `v#<n+1>` + flip pointer), rollback (flip pointer only).
- `stats.ts` — dashboard queries: range of `day#` partitions (the `shared/range.ts`
  pattern), cohort reads for retention, "estimated month cost" derived from our own
  counters (§ DESIGN 5 honesty rule: never call it a spending cap).
- `players.ts` — "delete this player": given an installId, compute hash, delete player row
  + uniq rows; documented as the GDPR support-path.
- `/teardown` — DeleteStack + wait + deploy-bucket sweep; `certify` must end clean
  (`leaves-no-trace.cert.json` in-repo like TrafficPoppy).

Admin plane talks straight to DynamoDB with broker-vended scoped creds — no Lambda in the
admin path (TrafficPoppy pattern).

## 6. Frontend (`frontend/src/` — Vite + React, poppy.css/theme.css copied)

Screens per DESIGN §7 with these implementation notes:

- `Dashboard.tsx` — DAU sparkline, sessions, avg length (`sess#seconds / sess#count`),
  D1/D7/D30 (cohort dN ÷ size), platform/version bars, cost line.
- `Events.tsx` — top events table + `__other` overflow warning banner.
- `ConfigEditor.tsx` — JSON textarea with client-side parse/validate, env switch (A5),
  publish behind an **inline confirm** (house rule: no `window.confirm` in the webview),
  history list with per-version rollback, "what the client sees" curl preview (CopyButton).
- `Titles.tsx` — create flow surfaces the key exactly once with a copy button + "store it
  now" warning; per-title caps; rotate with grace-period explainer.
- `Sdk.tsx` — "Export for Unity" renders `LiveOpsPoppy.cs` from a template literal with
  endpoint/titleId/key(placeholder) baked in → download + copy; REST tab with curl for both
  endpoints.
- `Settings.tsx` / `RemovePanel.tsx` / `Resources` view / vendored Feedback tab /
  `entitlement.ts` + `Purchase.tsx` (commerce, A1) — all straight ports of existing
  patterns.
- **Demo mode before connect** (TrafficPoppy `demo.html` / MailPoppy demo-inbox pattern):
  a fake studio with plausible curves so the store listing and first launch show a living
  product — this doubles as the "taste before the AWS obstacle" marketing asset.

## 7. The Unity SDK (`sdk/LiveOpsPoppy.cs` — generated, not a package)

Spec for the single file (~400 lines, zero dependencies, Unity 2020.3+ / .NET Standard 2.1):

- `LiveOpsPoppy.Init()` (endpoint + title key baked in by the generator); creates a
  DontDestroyOnLoad singleton.
- Config: fetch on Init + every 5 min; ETag revalidation; last-good JSON cached to
  `Application.persistentDataPath/liveops-config.json`; **fully offline boot works**
  (falls back to cache, then to in-code defaults via `GetInt/GetFloat/GetString/GetBool
  (key, default)` — flat key access into the JSON, dotted paths for nesting).
- Events: `Track(name)` / `Track(name, value)`; queue persisted to
  `liveops-queue.json`; flush every 30 s + on `OnApplicationPause(true)` + quit;
  batches of ≤25; exponential backoff (max 5 min), 429 ⇒ sleep to next UTC day.
- Auto: installId GUID in PlayerPrefs; session_start on Init (new sid), session_end with
  duration on pause/quit (best-effort); platform + appVersion attached from Unity APIs.
- Test rig: a throwaway Unity scene project (NOT in this repo — a sibling folder) with
  buttons for Track/config-read; manual verification, no Unity in CI.

## 8. Phases (each ends green: `npm run typecheck && npm run test`, + `certify` from P3)

| Phase | Deliverable | Done when |
|---|---|---|
| **P0 scaffold** | workspaces, tsconfigs, extension.json, icon, LICENSE, CLAUDE.md, Feedback tab vendored, validate-manifest green | `install-dev` loads a hello screen in AgentsPoppy |
| **P1 core + template** | `infra/template.ts` + tests; `lambdas/core.ts` pure logic (key check, caps, cardinality, retention flags, ETag) fully tested; store.ts | template JSON snapshot-tested; core coverage of every §3/§4 rule incl. cap-boundary and `__other` overflow |
| **P2 collector** | `collector.ts` routes both endpoints | handler tests: 403/304/202/429 paths; body-size + batch-size rejects |
| **P3 sidecar** | boot/server/stack/deploy-bucket/titles/config/stats/players/teardown | deploy→publish→rollback→teardown loop green against a REAL account (founder confirms first, spare account, torn down + clean-swept per working agreements); `certify` clean |
| **P4 frontend** | all §6 screens + demo mode + commerce | dev-walk of every screen; unit tests with injected mock API (house pattern) |
| **P5 SDK + docs** | Sdk.tsx generator + `LiveOpsPoppy.cs` template + REST docs | Unity test rig: offline boot, config change visible ≤5 min, events land in dashboard, 429 backoff observed under a synthetic flood |
| **P6 listing** | screenshots, data-flow declaration ("no data leaves your cloud" label), catalogue submission, pack + release zip, first-party product ($79/yr sub) in AgentsPoppy admin | anonymous-curl 200 on the package URL (the 07-30 mirror lesson); purchase → entitlement resolves |

**Live-verification gate (P3/P5):** synthetic flood proving the event cap bounds the bill
(send cap+10k events, verify 429s + counter stops), and a full teardown clean-sweep. Both
follow the MailPoppy live-test discipline: spare resources, explicit founder confirmation
before anything mutating, verify the account is clean afterwards.

## 9. What is deliberately NOT in this plan

Raw S3 archive (A2), saves/leaderboards (v2, DESIGN §11a), CloudFront/WAF/custom domain,
percentage rollouts, Godot/Unreal SDKs (v1.1+), any player-facing auth, FlagPoppy (§11b —
but `config.ts` + the config plane of `core.ts` must stay games-agnostic so it can be
lifted).

## 10. Order of work & first session

P0+P1 are one sitting (scaffold is mechanical, core.ts is the thinking). Suggested split:
session 1 = P0–P2 (everything unit-testable, no AWS), session 2 = P3 + live gate,
session 3 = P4, session 4 = P5–P6. Like CrewPoppy/VPN-Poppy, implementation runs in its own
Claude session with this file + DESIGN.md as the brief.
