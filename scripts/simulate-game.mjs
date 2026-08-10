#!/usr/bin/env node
/**
 * Pretend to be a game, so the whole backend can be tested without opening Unity.
 *
 * It does exactly what the generated LiveOps.cs does: fetch remote config (twice, so the
 * ETag/304 path is exercised), then send batched session + custom events for a number of
 * simulated players. Dependency-free — plain fetch.
 *
 *   node scripts/simulate-game.mjs \
 *     --endpoint https://<your>.lambda-url.<region>.on.aws \
 *     --title <titleId> --key <titleKey> [--players 25] [--env prod]
 *
 * Then open the poppy's Dashboard: players, sessions, average length and the event
 * breakdown should match what this printed.
 *
 * Every player id is random per run, so re-running adds NEW players rather than
 * re-counting the same ones. Pass --stable to reuse a fixed set instead (that's how you
 * check that daily-unique counting doesn't double-count a returning player).
 *
 * ── Flood mode ────────────────────────────────────────────────────────────────────────
 * The bill-protection proof. Drives a title past its daily event cap and checks that the
 * backend refuses the rest of the day:
 *
 *   node scripts/simulate-game.mjs --endpoint <url> --title <id> --key <k> --flood --yes
 *
 * Do this on a THROWAWAY title with its cap turned down (Titles → cap → e.g. 2000) — the
 * point is to trip the cap cheaply, not to spend real money proving arithmetic. Once
 * tripped, the title accepts no more events until 00:00 UTC: the cap meter counts what
 * ARRIVED and is deliberately not decremented on refusal.
 */

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    i += 1;
  } else {
    args.set(key, "true");
  }
}

const endpoint = (args.get("endpoint") ?? "").replace(/\/+$/, "");
const titleId = args.get("title") ?? "";
const key = args.get("key") ?? "";
const env = args.get("env") ?? "prod";
const players = Number(args.get("players") ?? 25);
const stable = args.get("stable") === "true";
const flood = args.get("flood") === "true";
const confirmed = args.get("yes") === "true";
const concurrency = Number(args.get("concurrency") ?? 8);
const maxEvents = Number(args.get("max-events") ?? 50_000);

if (!endpoint || !titleId || !key) {
  console.error(
    "Usage: node scripts/simulate-game.mjs --endpoint <url> --title <titleId> --key <titleKey>\n" +
      "         [--players 25] [--env prod] [--stable]\n" +
      "         [--flood --yes [--max-events 50000] [--concurrency 8]]",
  );
  process.exit(1);
}

const MAX_BATCH = 25; // must match shared/src/keys.ts

/** The event mix a real session produces — weighted so the dashboard looks plausible. */
const EVENT_MIX = [
  ["level_complete", 4],
  ["level_fail", 3],
  ["shop_open", 2],
  ["purchase", 1],
  ["tutorial_done", 1],
];

const pick = () => {
  const total = EVENT_MIX.reduce((a, [, w]) => a + w, 0);
  let n = Math.random() * total;
  for (const [name, weight] of EVENT_MIX) {
    n -= weight;
    if (n <= 0) return name;
  }
  return EVENT_MIX[0][0];
};

const PLATFORMS = ["android", "ios", "windows"];
const VERSIONS = ["1.4.2", "1.4.2", "1.4.1", "1.3.9"];

async function fetchConfig(etag) {
  const url = `${endpoint}/config/${titleId}/${env}?k=${encodeURIComponent(key)}`;
  const res = await fetch(url, etag ? { headers: { "if-none-match": etag } } : undefined);
  if (res.status === 304) return { status: 304, etag };
  if (!res.ok) throw new Error(`config ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return { status: res.status, etag: res.headers.get("etag"), body };
}

async function sendBatch(installId, sessionId, platform, version, events) {
  const res = await fetch(`${endpoint}/e`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      t: titleId,
      k: key,
      s: { iid: installId, sid: sessionId, plat: platform, ver: version },
      e: events,
    }),
  });
  const text = await res.text();
  return { status: res.status, text, retryAfterHeader: res.headers.get("retry-after") };
}

// ── Flood mode ─────────────────────────────────────────────────────────────────────────
// The cap is the one promise that has to hold against a hostile caller, because the title
// key ships inside the game binary and must be assumed public. So this doesn't simulate a
// polite client: it hammers one title until the backend says no, then checks that the "no"
// is well-formed, that it sticks, and that the config plane is unharmed by it.

const floodBatch = (n) => ({
  // One event name throughout — the cardinality guard is a separate concern, and letting it
  // fire here would muddy which limit actually stopped the flood.
  iid: `flood-${crypto.randomUUID()}`,
  sid: crypto.randomUUID().slice(0, 16),
  events: Array.from({ length: n }, () => ({ n: "flood_test" })),
});

async function sendFloodBatch() {
  const b = floodBatch(MAX_BATCH);
  return sendBatch(b.iid, b.sid, "linux", "flood", b.events);
}

async function floodMain() {
  if (!confirmed) {
    console.error(
      "Flood mode drives this title past its DAILY event cap. Once tripped it accepts no\n" +
        "more events until 00:00 UTC, and the events it does accept are real writes you pay\n" +
        "for. Use a throwaway title with its cap turned down, then re-run with --yes.",
    );
    process.exit(1);
  }

  console.log(`→ ${endpoint}  title=${titleId}  (flood: up to ${maxEvents} events)\n`);

  const checks = [];
  const check = (ok, label, detail = "") => {
    checks.push({ ok, label });
    console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  };

  let sent = 0;
  let accepted = 0;
  let firstRefusal = null;

  while (sent < maxEvents && !firstRefusal) {
    const inFlight = Math.min(concurrency, Math.ceil((maxEvents - sent) / MAX_BATCH));
    const results = await Promise.all(Array.from({ length: inFlight }, () => sendFloodBatch()));
    sent += inFlight * MAX_BATCH;
    for (const r of results) {
      if (r.status === 202) accepted += MAX_BATCH;
      else if (r.status === 429 && !firstRefusal) firstRefusal = r;
      else if (r.status !== 429) console.error(`  ! unexpected ${r.status}: ${r.text}`);
    }
    process.stdout.write(`\r  sent ${sent}  accepted ${accepted}   `);
  }
  process.stdout.write("\n\n");

  if (!firstRefusal) {
    console.log(
      `The cap did not trip after ${sent} events. That is not a failure — this title's cap is\n` +
        "simply higher than this run. Turn the cap down on a throwaway title (Titles → cap,\n" +
        "e.g. 2000) and run again; proving the limit cheaply is the whole point.",
    );
    process.exit(2);
  }

  console.log(`Refused after ~${accepted} accepted events. Checking the refusal:\n`);

  let body = {};
  try {
    body = JSON.parse(firstRefusal.text);
  } catch {
    /* checked below */
  }

  const headerSeconds = Number(firstRefusal.retryAfterHeader);
  check(Number.isFinite(headerSeconds) && headerSeconds > 0, "Retry-After header is a positive number of seconds", firstRefusal.retryAfterHeader ?? "absent");
  check(headerSeconds > 0 && headerSeconds <= 86_400, "Retry-After is within one day (it counts down to 00:00 UTC)", `${headerSeconds}s`);
  check(body.retryAfter === headerSeconds, "the body repeats retryAfter, for clients that cannot read headers");
  check(typeof body.error === "string" && body.error.length > 0, "the error is in plain English", body.error ?? "missing");
  check(!/dynamo|lambda|arn:|stack|table/i.test(firstRefusal.text), "no internals leak to a public caller");

  // The meter must not decay: a flood that keeps pushing must keep getting refused.
  const after = await Promise.all([sendFloodBatch(), sendFloodBatch(), sendFloodBatch()]);
  check(after.every((r) => r.status === 429), "the refusal sticks — later batches are refused too", after.map((r) => r.status).join(","));

  // The property that makes the cap safe to ship: telemetry stops, the GAME does not.
  try {
    const cfg = await fetchConfig();
    check(cfg.status === 200, "config still serves while capped — a capped title still boots", `${cfg.status}`);
  } catch (e) {
    check(false, "config still serves while capped", e.message);
  }

  const failed = checks.filter((c) => !c.ok).length;
  console.log(
    failed === 0
      ? "\nAll checks passed. The daily cap bounds this title's spend, and refuses in a way a\nclient can act on. Note it stays capped until 00:00 UTC.\n"
      : `\n${failed} check(s) failed — the cap is not behaving as documented in docs/REST.md.\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

async function main() {
  console.log(`→ ${endpoint}  title=${titleId}  env=${env}\n`);

  // 1. The config plane, including the cheap-revalidation path a real game relies on.
  const first = await fetchConfig();
  console.log(`config: ${first.status}  version=${first.body?.v}  etag=${first.etag}`);
  console.log(`        ${JSON.stringify(first.body?.config ?? {})}`);
  const second = await fetchConfig(first.etag);
  console.log(
    second.status === 304
      ? "config: 304 on re-fetch — ETag revalidation works (this is what keeps millions of boots cheap)\n"
      : `config: expected 304 on re-fetch, got ${second.status}\n`,
  );

  // 2. Telemetry, one session per simulated player.
  let sent = 0;
  let accepted = 0;
  let capped = 0;
  const counts = new Map();

  for (let i = 0; i < players; i += 1) {
    const installId = stable ? `sim-player-${String(i).padStart(4, "0")}` : `sim-${crypto.randomUUID()}`;
    const sessionId = crypto.randomUUID().slice(0, 16);
    const platform = PLATFORMS[Math.floor(Math.random() * PLATFORMS.length)];
    const version = VERSIONS[Math.floor(Math.random() * VERSIONS.length)];
    const seconds = 120 + Math.floor(Math.random() * 900);

    const events = [{ n: "session_start" }];
    const count = 3 + Math.floor(Math.random() * 8);
    for (let e = 0; e < count; e += 1) {
      const name = pick();
      counts.set(name, (counts.get(name) ?? 0) + 1);
      events.push(name === "purchase" ? { n: name, v: 4.99 } : { n: name });
    }
    events.push({ n: "session_end", v: seconds });

    const result = await sendBatch(installId, sessionId, platform, version, events);
    sent += events.length;
    if (result.status === 202) accepted += events.length;
    else if (result.status === 429) capped += events.length;
    else console.error(`  ! ${result.status}: ${result.text}`);
  }

  console.log(`sent ${sent} events for ${players} players — ${accepted} accepted${capped ? `, ${capped} refused (daily cap)` : ""}`);
  console.log("\nevent mix sent:");
  for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${name.padEnd(16)} ${n}`);
  console.log(
    `\nOpen the poppy's Dashboard — "Players today" should include these ${players},` +
      ` and the event breakdown should match the mix above.`,
  );
  if (capped > 0) {
    console.log("\nThe cap refused some events, which is the bill-protection guarantee working.");
  }
}

(flood ? floodMain() : main()).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
