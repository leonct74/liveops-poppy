// LiveOpsPoppy backend — the HTTP surface the host proxies frontend calls to, plus the
// teardown hook. Spawned by AgentsPoppy with AGENTSPOPPY_BOOTSTRAP; listens on the
// injected loopback port (never a fixed one). See AGENTS.md §7, DESIGN.md §3.
//
// The admin plane talks straight to DynamoDB with broker-vended scoped credentials — the
// collector Lambda is only ever on the GAME's path, never on the developer's.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { brokerCredentialsProvider, readBootstrap } from "./boot";
import { deploy, getStatus, tableName, teardown, type AwsCtx } from "./stack";
import { sourceCommit } from "./generated/backend-bundle";
import { TitleRegistry } from "./titles";
import { ConfigStore, parseEnv } from "./config";
import { StatsReader } from "./stats";
import { PlayerEraser } from "./players";
import { TITLE_ID_RE } from "../../shared/src/keys";

const boot = readBootstrap();
const credentials = brokerCredentialsProvider(boot);
const region = boot.account.region;

const aws: AwsCtx = {
  cfn: new CloudFormationClient({ region, credentials }),
  s3: new S3Client({ region, credentials }),
  region,
  accountId: boot.account.accountId,
};
const db = new DynamoDBClient({ region, credentials });

const titles = new TitleRegistry(db, tableName);
const configs = new ConfigStore(db, tableName);
const stats = new StatsReader(db, tableName);
const eraser = new PlayerEraser(db, tableName);

const attribution = { accountId: boot.account.accountId, connectionId: boot.connectionId };

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // The config editor posts documents up to 64 KB; anything an order of magnitude past
    // that is a bug or an attack, not a config.
    if (size > 1_000_000) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body is not valid JSON.");
  }
}

/** Reject a malformed title id before it reaches a key builder. */
function requireTitleId(raw: string | undefined): string {
  if (!raw || !TITLE_ID_RE.test(raw)) throw new Error("A valid title id is required.");
  return raw;
}

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    // ── Health + deployment lifecycle ───────────────────────────────────────────────
    if (method === "GET" && parts[0] === "health") {
      return json(res, 200, { ok: true, poppy: "liveopspoppy", region, sourceCommit });
    }
    if (method === "GET" && parts[0] === "status") {
      return json(res, 200, await getStatus(aws));
    }
    if (method === "POST" && parts[0] === "deploy") {
      return json(res, 200, await deploy(aws, attribution));
    }
    if (method === "POST" && parts[0] === "teardown") {
      return json(res, 200, { ok: true, ...(await teardown(aws)) });
    }

    // ── Titles ──────────────────────────────────────────────────────────────────────
    if (parts[0] === "titles") {
      if (method === "GET" && parts.length === 1) {
        return json(res, 200, { titles: await titles.list() });
      }
      if (method === "POST" && parts.length === 1) {
        const body = await readBody(req);
        // The key comes back exactly once; the UI must make that unmissable.
        return json(res, 200, await titles.create(body.name));
      }
      const titleId = requireTitleId(parts[1]);
      if (method === "GET" && parts.length === 2) {
        const title = await titles.get(titleId);
        return title ? json(res, 200, title) : json(res, 404, { error: "No such title." });
      }
      if (method === "DELETE" && parts.length === 2) {
        await titles.remove(titleId);
        return json(res, 200, { ok: true });
      }
      if (method === "POST" && parts[2] === "rotate-key") {
        return json(res, 200, await titles.rotateKey(titleId));
      }
      if (method === "POST" && parts[2] === "revoke-previous-key") {
        await titles.revokePreviousKey(titleId);
        return json(res, 200, { ok: true });
      }
      if (method === "POST" && parts[2] === "caps") {
        const body = await readBody(req);
        return json(res, 200, await titles.setCaps(titleId, body));
      }
      if (method === "POST" && parts[2] === "erase-player") {
        const body = await readBody(req);
        return json(res, 200, await eraser.erase(titleId, String(body.installId ?? "")));
      }

      // ── Remote config ─────────────────────────────────────────────────────────────
      if (parts[2] === "config") {
        const env = parseEnv(parts[3]);
        if (method === "GET" && parts.length === 4) {
          return json(res, 200, await configs.current(titleId, env));
        }
        if (method === "GET" && parts[4] === "history") {
          return json(res, 200, { versions: await configs.history(titleId, env) });
        }
        if (method === "POST" && parts.length === 4) {
          const body = await readBody(req);
          return json(res, 200, await configs.publish(titleId, env, String(body.json ?? ""), body.note ?? ""));
        }
        if (method === "POST" && parts[4] === "rollback") {
          const body = await readBody(req);
          return json(res, 200, await configs.rollback(titleId, env, Number(body.version)));
        }
      }

      // ── Stats ─────────────────────────────────────────────────────────────────────
      if (method === "GET" && parts[2] === "stats") {
        const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30), 1), 90);
        return json(res, 200, await stats.overview(titleId, days));
      }
      if (method === "GET" && parts[2] === "retention") {
        const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30), 1), 90);
        return json(res, 200, { cohorts: await stats.retention(titleId, days) });
      }
    }

    return json(res, 404, { error: `No route for ${method} /${parts.join("/")}` });
  } catch (e) {
    // The frontend shows this verbatim, so keep messages human (AGENTS.md §7).
    return json(res, 500, { error: (e as Error).message });
  }
});

const port = boot.port ?? (process.env.PORT ? Number(process.env.PORT) : 0);
server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  console.log(`[liveopspoppy] backend listening on 127.0.0.1:${actual} (region ${region})`);
});
