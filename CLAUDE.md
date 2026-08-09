# CLAUDE.md — LiveOpsPoppy

Operating guide for this repo. Decisions + rationale live in **`DESIGN.md`**; the build
contract (key literals, endpoint shapes, phases) lives in **`IMPLEMENTATION.md`** — both are
source of truth, update them when a decision changes.

> Standalone project. Runs *on* AgentsPoppy (sibling checkout expected at `../agentspoppy`,
> override with `AGENTSPOPPY_REPO`). Reference codebase: `../traffic-poppy` — same layout,
> same pipeline. Never touch the mailpoppy / traffic-poppy / vm-poppy repos from here.

## What it is

Game-developer poppy: **remote config** (change balance/prices/features live, versioned
publish + rollback, no app-store review) + **player telemetry** (DAU, sessions, D1/D7/D30
retention, custom events), all in the studio's own AWS. One stack: one DynamoDB table + one
collector Lambda behind a Function URL. v1 has **no cloud saves, no leaderboards, no raw S3
archive** (deliberate — DESIGN §11a, IMPLEMENTATION A2).

## Commands

- `npm install` (root, workspaces)
- `npm run typecheck` · `npm run test` — must stay green; pretypecheck regenerates the bundle
- `npm run gen:backend` — infra template + collector zip → `backend/src/generated/backend-bundle.ts`
- `npm run build` — frontend (Vite) + backend (`backend/index.cjs`, node22 shared runtime)
- `npm run validate-manifest` — REAL SDK structural check + REAL risk assessor; fails on any
  finding that reaches beyond our own resources
- `npm run install-dev` / `npm run pack` / `npm run certify` — via the agentspoppy checkout

## Gotchas (inherited from the older poppies — they all bit for real)

1. **🪤 Stale backend bundle**: `backend/index.cjs` EMBEDS the template + Lambda zip. After
   ANY change under `infra/` or `lambdas/`, run `npm run build` (or at least `gen:backend` +
   `build:backend`) AND fully restart AgentsPoppy — or deploys report `NO_CHANGE` against old
   code while looking healthy.
2. **node22 shared runtime only** (agentspoppy docs/RUNTIMES.md R1). No SEA, no embedded
   Node, package platform-`any`. The SEA pipeline is banned; don't resurrect it from
   traffic-poppy's leftover `build-sidecar.mjs`.
3. **A public Function URL needs BOTH permission statements** (`InvokeFunctionUrl` gated to
   NONE + `InvokeFunction` gated to `InvokedViaFunctionUrl`) — one alone = anonymous 403.
   Locked by template tests; don't "simplify" it.
4. **Key literals are the public contract.** The DynamoDB pk/sk shapes in
   `lambdas/src/core.ts` are documented for studios' own BI tools and locked by tests —
   changing one is a breaking schema change, not a refactor.
5. **This poppy is pseudonymous, NOT anonymous.** Retention needs cross-day identity
   (per-title salted hash of a random install id). Never copy TrafficPoppy's
   "cryptographically unlinkable" privacy claims into UI/docs here (DESIGN §6).
6. **Deterministic data keys**: never let a data-affecting value fall back to `new Date()`
   implicitly — day bucketing uses the server receive time passed down explicitly
   (MailPoppy's importer idempotency lesson).

## Working agreements (live AWS)

- Explicit founder confirmation before ANY command that creates/changes/deletes AWS
  resources. Read-only checks are fine.
- Live tests: spare account/resources, tear down after, verify the account is clean
  (`certify` writes `leaves-no-trace.cert.json`).
- Never commit with AI attribution (no `Co-Authored-By`), founder rule.
