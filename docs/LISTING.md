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

- **Screenshots (take from a dev install at submission time, ≤8, captions ≤120 chars):**
  1. Deployment card mid-deploy — "Your LiveOps stack, deploying into your own account"
  2. Dashboard with data — "Yesterday's players, sessions and events — from your own DynamoDB"
  3. Dashboard $0 state — "Nothing has arrived yet, so nothing is being billed"
  4. Config editor — "Flip a flag; your live game sees it in seconds"
  5. SDK export — "One generated C# file. Drop it into Unity and call Track()"

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

## Gates before Submit (in order)

1. **Live deploy verification** (founder AWS approval required — creates real
   resources): deploy from a dev install, then per IMPLEMENTATION.md §8: run the
   simulator (`scripts/simulate-game.mjs`) against the live collector, see the
   dashboard fill; check the backend log for `price list …` and confirm the
   dashboard does **not** show the built-in-figures fallback notice (the
   `pricing:GetProducts` live path has NEVER answered — both local profiles 403);
   flood mode to prove the 429 cap; then **teardown and verify the account is
   clean**. Use a spare account/region per the working agreements.
2. **Publish the zip on a PUBLIC host** (`release/com.liveopspoppy.desktop-0.1.0-any.zip`,
   sha256 `dfb8bc6a…`): flip this repo public, or publish on a public releases repo
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
