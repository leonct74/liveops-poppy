# LiveOpsPoppy — catalogue listing pack (P6)

Everything the submission form asks for, ready to paste. Prepared 2026-08-11; the
**Gates** section at the bottom is what must be true before clicking Submit.

## Store page

- **Name:** LiveOpsPoppy
- **Category:** `gaming` — the Gaming shelf (added to the catalogue 2026-08-11;
  LiveOpsPoppy is its first occupant, matching the site hero's "vibe-code the cloud
  backend for your game").
- **Tagline:** Your game's LiveOps backend, in your own AWS.
- **Description:**

  > Change balance values, prices and feature flags in your LIVE game without
  > shipping an update — and see what players actually do, on infrastructure you
  > own. LiveOpsPoppy deploys a serverless LiveOps backend (event collector,
  > remote config, daily dashboards) into your own AWS account, then hands you a
  > generated SDK: one C# file for Unity, or a plain REST contract for any other
  > engine. Costs pennies at indie scale, ~$0 at idle, and the dashboard shows the
  > real figure from AWS's own price list. Player events go to YOUR account —
  > nothing passes through us. One click removes everything it created.

- **Features (all free — no paid tier in v1):**
  - Remote config & feature flags — change your live game without an app update
  - Event collector with daily dashboards (players, sessions, custom events)
  - Generated Unity SDK (one C# file) + a documented REST contract for any engine
  - Daily event cap with 429 backpressure, so a bug in your game can't run up your bill
  - Live cost estimate from AWS's own price list — including the honest "$0 so far" state
  - One-click teardown; resource transparency via the host

- **Screenshots** — ✅ THREE shipped (3rd added 2026-08-14): captured headlessly from the
  demo-mode frontend (`?screen=<tab>` param added for exactly this; regen with
  Chrome `--headless --screenshot` at 1400×1015 → `cwebp -q 82`), staged in
  agentspoppy-web `public/poppies/liveopspoppy/{1,2}.webp` — dashboard with demo
  data + the config editor with history. Still to take DURING the live-deploy
  gate (demo mode can't pose for them honestly):
  1. Deployment card mid-deploy — "Your LiveOps stack, deploying into your own account"
  2. Titles & SDK with the generated C# — "One generated C# file. Drop it into Unity and call Track()"

  **3.webp — the team dashboard (2026-08-14).** Captured from a local RIG, not the
  frontend's demo mode: this page is served by the viewer Lambda and needs a signed-in
  Cognito viewer, so the `?screen=` trick does not reach it. The rig runs the REAL handler
  (`lambdas/src/viewer.ts`, bundled with esbuild) behind a plain node http server with a
  fake same-origin Cognito, plus a `?auto=1` harness-only injection that waits for the
  page's `/api/config` to land before submitting the form — clicking earlier throws,
  because `signIn()` dereferences `cognito`. Captured over CDP (`shoot.mjs`), NOT
  `--screenshot`: virtual time fires without waiting for the real fetch and catches the
  login form mid-submit. 1400x1105 at DPR 2 → `sips --resampleWidth 1400` → `cwebp -q 82`.
  **The numbers in it are seeded sample data** (a 30-day curve with real retention
  cohorts); the UI is production code. Same rig is the only way to test this page's CSP —
  it found two browser-only bugs no server-side test could see.

- **Age rating:** `everyone` (admin tool; questionnaire answers are all "no").
- **Data & privacy:** **No data leaves the user's cloud.** Player events flow from
  the game to the admin's own collector endpoint (their API Gateway → their
  DynamoDB). The only outbound call is AWS's public Price List API (no customer
  data in the request). → qualifies for the "Data stays in your cloud" label.
- **Support email:** same as the other first-party poppies.
- **bugsUrl:** `https://github.com/leonct74/liveops-poppy/issues` — **currently
  PRIVATE; see gate 3.**

## License — RESOLVED (founder decision 2026-08-11)

**License: `PolyForm-Shield-1.0.0`, straight from the accepted list.** The store
policy was changed the same day this pack was written: source-available noncompete
licenses (PolyForm Shield/Perimeter, FSL-1.1) are now an accepted tier for
*everyone* — the boundary is user rights (read, audit, build, run, patch your own
install, commercial use — all of which Shield grants), not developer-vs-developer
code reuse. A noncompete never stops anyone building a similar poppy from scratch;
it only stops them building it out of this code, which the originality rule forbids
anyway. Same rules for first-party and third-party — /developers/licensing says so
explicitly. (Policy commit in agentspoppy-web, 2026-08-11; ships with the held web
deploy.)

## 0.2.0 (2026-08-12) — the packaged version, and a permission fix

The 0.1.0 zip was **stale**: packed before T1–T4, so it carried none of the Team plane.
Repacked as **0.2.0** (Team tab is a new paid capability, so a minor bump, not a re-cut).

Repacking surfaced a real defect in the T1 manifest, now fixed by copying TrafficPoppy:
the Cognito grant was a single `arn:aws:cognito-idp:*:*:userpool/*` statement covering
`DeleteUserPool` / `AdminDeleteUser` / `ListUsers`. A pool ARN's id segment is generated
by AWS, so that wildcard reaches **every user pool in the account** — another poppy's
mailbox pool included — while the consent text claimed nothing outside `LiveOpsPoppy*`
was reachable. Neither the risk assessor (any scope that isn't literally `"*"` reads as
"named") nor the manifest validator flags it.

Now split exactly as TrafficPoppy does:

- `userpool/*` — Create/Describe + Tag/UntagResource only (nothing that reads a user or
  destroys a pool). `TagResource` is required because CloudFormation tags a pool in a
  separate call after creating it (CrewPoppy's live rollback, 2026-07-30).
- `tagged-as-self` — every Delete/Update/Admin/List action, so IAM confines them to pools
  carrying LiveOpsPoppy's own tag.

That only holds if the pool is **born tagged**, so `ViewerPool` now sets `UserPoolTags`
from new `AttrAccountId`/`AttrConnectionId` stack parameters (stack-tag propagation alone
is not enough — TrafficPoppy P5 caught CFN's ACM handler dropping tags on create).
`TEMPLATE_REVISION` 2 → 3. Locked by tests: `manifest.test.ts` (5) fails if any
destructive Cognito action escapes the tag scope, and `template.test.ts` fails if the
pool loses its birth tags. 247 tests green.

**Still unproven:** that Cognito actually honours `aws:ResourceTag` for these actions.
Deploy with the Team dashboard ON during gate 1 and confirm invite/list/delete-viewer
work — if Cognito ignores the tag condition, they will 403.

## Status 2026-08-11: SEEDED (held)

The catalogue entry is written and verified — `catalog-seed.json` in agentspoppy-web
(category gaming, license PolyForm-Shield-1.0.0, no packages → the page says "listed
but has not published a downloadable package yet"). It sits in a clearly-labelled
held commit that **must not deploy before this repo is public** (the listing links
repo + issues). After the live gate: publish the zip, add `packages` + bump
screenshots, and the listing becomes installable.

## Gates before Submit (in order)

1. **Live deploy verification** (founder AWS approval required — creates real
   resources): deploy from a dev install, then (IMPLEMENTATION.md never existed —
   the steps are here, with the request/response detail in docs/REST.md and the
   flood procedure in docs/UNITY.md §"You do not need Unity"): run the
   simulator (`scripts/simulate-game.mjs`) against the live collector, see the
   dashboard fill; check the backend log for `price list …` and confirm the
   dashboard does **not** show the built-in-figures fallback notice (the
   `pricing:GetProducts` live path has NEVER answered — both local profiles 403);
   flood mode to prove the 429 cap; then **teardown and verify the account is
   clean**. Use a spare account/region per the working agreements.
   **Deploy with the Team dashboard ON for at least one pass** — the viewer pool has
   never been created live, and it is what proves the tag-scoped Cognito grant works
   (invite / list / delete a viewer). Confirm the created pool carries the four
   `agentspoppy:*` tags; without them every viewer-management call 403s.
2. **Publish the zip on a PUBLIC host** (`release/com.liveopspoppy.desktop-0.2.0-any.zip`,
   sha256 `6d72b503…`): flip this repo public, or publish on a public releases repo
   like the MailPoppy mirror. Before touching the catalogue:
   `curl -sIL -o /dev/null -w '%{http_code}\n' <url>` with **no credentials** must
   print 200 — the private-repo 404 trap bit MailPoppy for real on 2026-07-30.
3. **bugsUrl must answer publicly** — same repo-public decision as gate 2, or point
   it at a public tracker. Fetch it anonymously, require 200.
4. **minHost is 0.3.0** (shared node22 runtime) and the manifest declares
   `isolation: "strict"` — confined boot verified 2026-08-11 with the broker's real
   confinement flags. Nothing to do; recorded so the catalogue entry carries both.
5. Screenshots (gate 1's install is the chance to take them).

## Deliberately not claimed at listing

- The Unity SDK has never been compiled by a real C# compiler — REST is the
  supported surface until docs/UNITY.md has been run on a machine with Unity.
  Listing copy says "generated SDK", never "battle-tested".
