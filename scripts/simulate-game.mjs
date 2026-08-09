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

if (!endpoint || !titleId || !key) {
  console.error(
    "Usage: node scripts/simulate-game.mjs --endpoint <url> --title <titleId> --key <titleKey> [--players 25] [--env prod] [--stable]",
  );
  process.exit(1);
}

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
  return { status: res.status, text };
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

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
