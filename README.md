# LiveOpsPoppy

**Your game's LiveOps backend, in your own AWS account.**

Change game balance, prices and features in a live game without shipping a build through
store review — and see players, sessions and retention on a dashboard nobody else can read.
No per-player fees, no vendor in the data path.

An [AgentsPoppy](https://agentspoppy.com) extension: it installs into the studio's own AWS
account, and Olly Digital never sees a byte of the data.

## What it does

- **Remote config** — versioned JSON per environment (`dev` / `prod`), published in
  seconds, rolled back in one click. Games revalidate cheaply with an ETag, and boot fine
  offline from their last cached copy (or their own in-code defaults).
- **Telemetry** — daily active players, sessions and length, D1/D7/D30 retention cohorts,
  custom events, platform and version splits.
- **Bill protection** — a per-title daily event cap enforced in real time, plus a
  cardinality guard, because the title key ships inside the game binary and must be
  assumed public.
- **One-file Unity SDK**, generated with the studio's own endpoint baked in. Every other
  engine talks to two plain HTTPS endpoints.

## Why not PlayFab / Unity Gaming Services / GameAnalytics

They meter per player or per event, they hold the studio's player data, and a shipped game
can be repriced under it. Here the "vendor" is a CloudFormation stack the studio owns: a
hit game costs the same flat licence fee as a prototype, the data lives in the studio's own
DynamoDB in a documented schema, and if this project vanished tomorrow every deployed
backend keeps running.

## Repo layout

```
infra/      the CloudFormation template, authored as typed TypeScript (no cdk)
lambdas/    the collector — remote config + telemetry ingestion
backend/    the admin plane AgentsPoppy runs (deploy, titles, config, stats)
frontend/   the poppy's screens (React + Vite)
shared/     the DynamoDB schema contract both planes import
```

## Development

```bash
npm install
npm run typecheck && npm run test
npm run build                # frontend + backend bundle
npm run validate-manifest    # real SDK check + real risk assessor
npm run install-dev          # load into a local AgentsPoppy
```

After **any** change under `infra/` or `lambdas/`, run `npm run build` and fully restart
AgentsPoppy — the backend bundle embeds the template and the Lambda zip, and a stale bundle
silently deploys old code. See `CLAUDE.md` for the rest of the traps.

`DESIGN.md` holds the decisions and rationale; `IMPLEMENTATION.md` holds the build contract
(key literals, endpoint shapes, phases).

## Status

Phases P0–P4 are built and tested (141 tests). Not yet deployed to a live AWS account, and
not yet listed in the AgentsPoppy catalogue.

## Licence

PolyForm Shield 1.0.0 — source-available. Read it, audit it, build it, run it; you just
can't ship a competing product with it.
