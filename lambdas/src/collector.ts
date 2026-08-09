// The collector Lambda — LiveOpsPoppy's ONLY public surface (DESIGN.md §3):
//
//   GET  /config/{titleId}/{env}?k=<titleKey>   remote config, ETag/304, 60 s cache
//   POST /e                                     telemetry batches, cap-gated
//
// It runs on the hot path of real games, so: never leak internals in an error body,
// never fail a game boot because of our own state (missing config serves defaults),
// and keep the per-request work bounded (the caps are checked BEFORE the fan-out).

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  capExceeded,
  CONFIG_MAX_AGE_S,
  cohortPk,
  dayPk,
  daysBetween,
  etagFor,
  expiryEpoch,
  isValidEnv,
  keyMatches,
  MAX_BODY_BYTES,
  parseBatch,
  planBatch,
  playerHash,
  PLAYER_TTL_DAYS,
  retentionBucket,
  secondsToUtcMidnight,
  SK_DAU,
  SK_SESS_COUNT,
  SK_SESS_SECONDS,
  skPlat,
  skVer,
  TITLE_ID_RE,
  UNIQ_TTL_DAYS,
  utcDay,
  type EventBatch,
  type TitleMeta,
} from "./core";
import { makeStore, type Store } from "./store";

/** The slice of the Function-URL (payload v2) event we read. */
export interface UrlEvent {
  rawPath?: string;
  requestContext?: { http?: { method?: string } };
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

export interface UrlResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const JSON_HEADERS = { "content-type": "application/json" };

function json(statusCode: number, body: unknown, extra: Record<string, string> = {}): UrlResponse {
  return { statusCode, headers: { ...JSON_HEADERS, ...extra }, body: JSON.stringify(body) };
}

/** One answer for "no such title" AND "wrong key" — title ids stay unenumerable. */
const FORBIDDEN = () => json(403, { error: "Unknown title or bad key." });

async function handleConfig(
  store: Store,
  titleId: string,
  env: string,
  key: string | undefined,
  ifNoneMatch: string | undefined,
): Promise<UrlResponse> {
  if (!TITLE_ID_RE.test(titleId) || !isValidEnv(env)) return json(404, { error: "Not found." });
  const meta = await store.getTitleMeta(titleId);
  if (!meta || !key || !keyMatches(key, meta)) return FORBIDDEN();

  const current = await store.getCurrentConfig(titleId, env);
  const etag = etagFor(current.version);
  const cacheHeaders = {
    etag,
    "cache-control": `public, max-age=${CONFIG_MAX_AGE_S}`,
  };
  if (ifNoneMatch === etag) {
    return { statusCode: 304, headers: cacheHeaders, body: "" };
  }
  // A never-published env serves {v:0, config:{}} — a game must never break because the
  // studio hasn't published yet (the SDK falls back to its in-code defaults).
  return json(200, { v: current.version, config: JSON.parse(current.json) }, cacheHeaders);
}

/** Apply one accepted batch to the counters. Exported for direct unit-testing. */
export async function processBatch(
  store: Store,
  meta: TitleMeta,
  batch: EventBatch,
  epochMs: number,
): Promise<void> {
  const day = utcDay(epochMs);
  const pkDay = dayPk(meta.titleId, day);
  const plan = planBatch(batch.events);
  const work: Promise<unknown>[] = [];

  // Custom event counters, cardinality-guarded.
  for (const [name, count] of plan.customCounts) {
    work.push(
      store
        .resolveEventSk(meta.titleId, day, name, meta.cardCap)
        .then((sk) => store.addCounter(pkDay, sk, count)),
    );
  }

  // Sessions: count/length pairs come from session_end so the average always divides
  // consistent units; platform/version distribution counts once per session_start.
  if (plan.sessionEndSeconds.length > 0) {
    const total = plan.sessionEndSeconds.reduce((a, b) => a + b, 0);
    work.push(store.addCounter(pkDay, SK_SESS_COUNT, plan.sessionEndSeconds.length));
    work.push(store.addCounter(pkDay, SK_SESS_SECONDS, total));
  }
  if (plan.sessionStarts > 0) {
    work.push(store.addCounter(pkDay, skPlat(batch.session.platform), plan.sessionStarts));
    work.push(store.addCounter(pkDay, skVer(batch.session.appVersion), plan.sessionStarts));

    // DAU + retention, keyed on the pseudonymous player hash (DESIGN.md §6).
    const hash = playerHash(meta.salt, batch.session.iid);
    work.push(
      (async () => {
        const isNewToday = await store.putUniq(
          meta.titleId,
          day,
          hash,
          expiryEpoch(epochMs, UNIQ_TTL_DAYS),
        );
        if (isNewToday) await store.addCounter(pkDay, SK_DAU, 1);
      })(),
    );
    work.push(
      (async () => {
        const playerTtl = expiryEpoch(epochMs, PLAYER_TTL_DAYS);
        const existing = await store.getPlayer(meta.titleId, hash);
        let firstSeen: string;
        if (!existing) {
          const created = await store.createPlayer(meta.titleId, hash, day, playerTtl);
          if (created) {
            await store.addCounter(cohortPk(meta.titleId, day), "size", 1);
            return; // brand new today — no retention bucket can apply yet
          }
          // Lost the create race — another invocation owns firstSeen; read it back.
          firstSeen = (await store.getPlayer(meta.titleId, hash))?.firstSeen ?? day;
        } else {
          firstSeen = existing.firstSeen;
        }
        await store.touchPlayer(meta.titleId, hash, day, playerTtl);
        const bucket = retentionBucket(daysBetween(firstSeen, day));
        if (bucket && (await store.markRetention(meta.titleId, hash, bucket))) {
          await store.addCounter(cohortPk(meta.titleId, firstSeen), bucket, 1);
        }
      })(),
    );
  }

  await Promise.all(work);
}

async function handleEvents(store: Store, rawBody: string, epochMs: number): Promise<UrlResponse> {
  const parsed = parseBatch(rawBody);
  if (!parsed.ok) return json(parsed.status, { error: parsed.error });
  const { batch } = parsed;

  const meta = await store.getTitleMeta(batch.titleId);
  if (!meta || !keyMatches(batch.key, meta)) return FORBIDDEN();

  // THE cap gate (DESIGN.md §5): total#events counts every RECEIVED event — it is the
  // cap meter, deliberately not decremented on drop, so a flood costs one write per
  // dropped batch and the meter shows what actually arrived.
  const day = utcDay(epochMs);
  const newTotal = await store.addTotal(batch.titleId, day, batch.events.length);
  if (capExceeded(newTotal, meta.eventCap)) {
    const retryAfter = secondsToUtcMidnight(epochMs);
    return json(429, { error: "Daily event cap reached for this title.", retryAfter }, {
      "retry-after": String(retryAfter),
    });
  }

  await processBatch(store, meta, batch, epochMs);
  return json(202, { ok: true, accepted: batch.events.length });
}

export function makeHandler(store: Store, nowMs: () => number = Date.now) {
  return async (event: UrlEvent): Promise<UrlResponse> => {
    try {
      const method = event.requestContext?.http?.method ?? "GET";
      const path = event.rawPath ?? "/";
      const headers = event.headers ?? {};

      if (method === "GET" && path.startsWith("/config/")) {
        const [, , titleId, env] = path.split("/");
        return await handleConfig(
          store,
          titleId ?? "",
          env ?? "",
          event.queryStringParameters?.k,
          headers["if-none-match"],
        );
      }

      if (method === "POST" && path === "/e") {
        const raw = event.body ?? "";
        // Reject oversized payloads before any decode work.
        if (raw.length > MAX_BODY_BYTES * 2) return json(413, { error: "Body too large." });
        const body = event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
        return await handleEvents(store, body, nowMs());
      }

      return json(404, { error: "Not found." });
    } catch (e) {
      // Log for the studio's own CloudWatch; never leak internals to the public caller.
      console.error("[liveopspoppy-collector]", (e as Error).message);
      return json(500, { error: "Internal error." });
    }
  };
}

// ── Lambda entrypoint (template.ts LAMBDA_HANDLER = "collector.handler") ───────────────
let defaultStore: Store | null = null;

export const handler = async (event: UrlEvent): Promise<UrlResponse> => {
  if (!defaultStore) {
    const tableName = process.env.TABLE_NAME;
    if (!tableName) throw new Error("TABLE_NAME is not set.");
    defaultStore = makeStore(new DynamoDBClient({}), tableName);
  }
  return makeHandler(defaultStore)(event);
};
