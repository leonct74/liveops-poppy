# How to test LiveOpsPoppy

Three levels, cheapest first. Level 1 needs nothing but the repo; level 2 needs no AWS
account at all; only level 3 creates resources and can cost money (a few cents).

---

## 1. The test suite — no app, no AWS

```bash
npm install
npm run typecheck && npm run test
```

141 tests. This covers the parts that are expensive to get wrong: the DynamoDB key
contract, the daily event cap, the cardinality guard, retention bucketing, config
publish/rollback, the update-ordering guard that refuses backend downgrades, and the
generated Unity source.

---

## 2. The poppy in AgentsPoppy, on demo data — no AWS account needed

```bash
npm run install-dev
```

Then **fully quit and reopen AgentsPoppy** (the broker only scans for extensions at
startup). LiveOpsPoppy appears in the sidebar.

It opens in **demo mode**: a made-up game ("Sunken Keep") with plausible numbers, so every
screen is explorable before you connect anything. What to look at:

| Tab | What you should see |
|---|---|
| Dashboard | ~1,600 players today, retention tiles, event and platform breakdowns, a cost line. Day-30 retention shows `—`, not `0%`, because no cohort is old enough — that honesty is deliberate. |
| Remote config | A live config document at v7, with history. Switch `dev` / `prod`. |
| Titles & SDK | The demo title. The SDK panel explains it needs a real endpoint first. |
| Setup | What LiveOpsPoppy would create in your account, and the "Set up my backend" button. |
| Feedback | The platform's standard rate / request / report / support panel. |

Every mutating control is hidden while on demo data — you cannot accidentally change
anything, because there is nothing to change.

**After any change to `lambdas/`, `infra/`, or `backend/`: re-run `npm run install-dev` and
fully restart AgentsPoppy.** The bundle embeds the CloudFormation template and the Lambda
zip; a stale bundle silently deploys old code and CloudFormation reports `NO_CHANGE`.

To uninstall: `rm -rf ~/.agentspoppy/extensions/com.liveopspoppy.desktop` and restart.

---

## 3. End-to-end against real AWS — creates resources

> Use a spare AWS account or one you're happy to see resources appear in. Everything is
> named `LiveOpsPoppy*` and "Remove everything" deletes all of it. Expect **cents**: the
> table is on-demand, the Lambda is idle unless called.

1. **Connect AWS** in AgentsPoppy and approve LiveOpsPoppy's permission set (rated amber:
   CloudFormation, DynamoDB, Lambda, IAM, Logs, S3 — all scoped to `LiveOpsPoppy*`).
2. **Setup tab → "Set up my backend."** The stack takes a couple of minutes; the panel
   polls and reports live progress. When it's done you get an HTTPS endpoint.
3. **Titles & SDK → create a title.** Copy the key **now** — it is shown once and only its
   hash is stored.
4. **Remote config → publish a document** to `prod`, e.g.
   `{"balance": {"shotgunDamage": 34}, "features": {"seasonalEvent": false}}`.
5. **Send traffic** without opening Unity — the simulator does exactly what the generated
   `LiveOps.cs` does:

```bash
node scripts/simulate-game.mjs --endpoint <your-endpoint> --title <titleId> --key <titleKey> --players 25
```

   It fetches config twice (the second should return **304** — that's the ETag
   revalidation that keeps millions of game boots cheap), then sends a session plus custom
   events for each simulated player, and prints the event mix it sent.

6. **Check the Dashboard.** Players, sessions, average session length and the event
   breakdown should match what the simulator printed.
7. **Test rollback.** Publish a second config version, confirm the game sees it
   (re-run the simulator — it prints the served config), then roll back and confirm it
   reverts.
8. **Test the bill guarantee.** Set the title's event cap low, then flood it:

```bash
node scripts/simulate-game.mjs --endpoint <url> --title <id> --key <key> --players 200
```

   Past the cap the collector answers **429** and stores nothing further; the simulator
   reports how many events were refused. This is the promise that a hostile player cannot
   run up the studio's AWS bill.

9. **Test daily uniques.** Re-run with `--stable` (a fixed set of player ids): "players
   today" should **not** grow, because those players already counted for the day.
10. **Remove everything** from the Setup tab, then confirm in the AWS console that no
    `LiveOpsPoppy*` stack, table, function, role, log group or `liveopspoppy-deploy-*`
    bucket remains. `npm run certify` automates that sweep.

---

## What is NOT yet testable

- **The Unity SDK in a real game.** The generated `LiveOps.cs` is unit-tested as source
  and mirrors the simulator's behaviour exactly, but it has not been compiled inside a
  Unity project. That's the remaining P5 work.
- **Cardinality overflow** needs more than 200 distinct event names in a day to trigger
  naturally; the unit tests cover the logic.
