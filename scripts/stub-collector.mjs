#!/usr/bin/env node
/**
 * A local stand-in for the collector's public surface (docs/REST.md), so a game client —
 * the sample game, a Unity build, anything — can be exercised with NO AWS account:
 *
 *   GET  /config/{titleId}/{env}?k=…   → the doc below, with ETag + 304 revalidation
 *   POST /e                            → validates the envelope loosely, logs the batch
 *
 * It accepts ANY title/key (this is a rig, not a fake of auth), prints every event batch
 * so you can watch the traffic, and can demo the two behaviours clients must handle:
 *
 *   node scripts/stub-collector.mjs                 # config v7, accept everything
 *   node scripts/stub-collector.mjs --cap 20        # answer 429 after 20 events (the bill guard)
 *   node scripts/stub-collector.mjs --bump          # +1 config version every 30s (rollout demo)
 *
 * Point the sample game at http://127.0.0.1:8322 with any title (e.g. demo1234) and any
 * 8+ char key. CORS mirrors the real Function URL config, ExposeHeaders included.
 */
import { createServer } from "node:http";

const PORT = 8322;
const cap = process.argv.includes("--cap") ? Number(process.argv[process.argv.indexOf("--cap") + 1] ?? 20) : Infinity;
const bump = process.argv.includes("--bump");

let version = 7;
const config = () => ({
  balance: { shotgunDamage: 34 + (version - 7) * 6, bossHealthMultiplier: 1.15 },
  shop: { starterBundlePrice: version % 2 ? 4.99 : 2.99, weekendSaleActive: version % 2 === 0 },
});
if (bump) setInterval(() => { version++; console.log(`config bumped → v${version}`); }, 30_000);

let accepted = 0;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST",
  "access-control-allow-headers": "content-type, if-none-match",
  "access-control-expose-headers": "etag, retry-after",
};

createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

  const url = new URL(req.url, "http://x");
  const cfgMatch = url.pathname.match(/^\/config\/([a-z0-9]{4,32})\/(dev|prod)$/);
  if (req.method === "GET" && cfgMatch) {
    const etag = `"v${version}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ...CORS, etag, "cache-control": "public, max-age=60" });
      console.log(`GET config → 304 (client holds v${version})`);
      return res.end();
    }
    res.writeHead(200, { ...CORS, "content-type": "application/json", etag, "cache-control": "public, max-age=60" });
    console.log(`GET config → 200 v${version}`);
    return res.end(JSON.stringify({ v: version, config: config() }));
  }

  if (req.method === "POST" && url.pathname === "/e") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { ...CORS, "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "Body is not JSON." }));
      }
      const events = Array.isArray(parsed?.e) ? parsed.e : [];
      if (accepted + events.length > cap) {
        res.writeHead(429, { ...CORS, "content-type": "application/json", "retry-after": "3600" });
        console.log(`POST /e → 429 (cap ${cap} reached)`);
        return res.end(JSON.stringify({ error: "Daily event cap reached for this title.", retryAfter: 3600 }));
      }
      accepted += events.length;
      console.log(
        `POST /e → 202 · iid=${String(parsed?.s?.iid ?? "?").slice(0, 8)} sid=${String(parsed?.s?.sid ?? "?").slice(0, 8)}` +
          ` · ${events.map((e) => e.n + (e.v !== undefined ? `(${e.v})` : "")).join(", ")} · total=${accepted}`,
      );
      res.writeHead(202, { ...CORS, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, accepted: events.length }));
    });
    return;
  }

  res.writeHead(404, CORS);
  res.end();
}).listen(PORT, () => console.log(`stub collector on http://127.0.0.1:${PORT} (cap=${cap === Infinity ? "none" : cap}${bump ? ", bumping config every 30s" : ""})`));
