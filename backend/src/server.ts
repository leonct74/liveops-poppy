// LiveOpsPoppy backend — the HTTP surface the host proxies frontend calls to, plus the
// teardown hook. Spawned by AgentsPoppy with AGENTSPOPPY_BOOTSTRAP; listens on the
// injected loopback port (never a fixed one). See AGENTS.md §7, DESIGN.md §3.
//
// P0 STATUS: a contract-correct skeleton — bootstrap + health only. The deploy/teardown
// and admin-plane routes (titles, config, stats — IMPLEMENTATION.md §5) land in P3.

import { createServer, type ServerResponse } from "node:http";
import { readBootstrap } from "./boot";
import {
  lambdaCodeKey,
  sourceCommit,
  stackName,
  templateKey,
  templateRevision,
} from "./generated/backend-bundle";

const boot = readBootstrap();

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  try {
    if (method === "GET" && path === "/health") {
      return json(res, 200, {
        ok: true,
        poppy: "liveopspoppy",
        stackName,
        templateRevision,
        templateKey,
        lambdaCodeKey,
        sourceCommit,
        region: boot.account.region,
      });
    }
    if (method === "POST" && path === "/teardown") {
      // P3 wires the real DeleteStack + deploy-bucket sweep. Refusing loudly beats
      // pretending: the host must never believe a teardown succeeded when nothing ran.
      return json(res, 501, { error: "Teardown is not implemented yet (P3) — nothing was deployed by this build." });
    }
    return json(res, 404, { error: `No route for ${method} ${path}` });
  } catch (e) {
    return json(res, 500, { error: (e as Error).message });
  }
});

const port = boot.port ?? (process.env.PORT ? Number(process.env.PORT) : 0);
server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  console.log(`[liveopspoppy] backend listening on 127.0.0.1:${actual} (region ${boot.account.region})`);
});
