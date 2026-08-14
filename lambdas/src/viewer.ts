// The viewer Lambda — the PREMIUM team dashboard (DESIGN §10).
//
// Two routes on its own Function URL:
//   GET /            the dashboard page (self-contained HTML; no CDN, no build step)
//   GET /api/stats   the numbers, for a verified viewer only
//
// The whole point is that a studio's producer, designer or investor reads the game's
// numbers in a plain browser with NO AgentsPoppy install and NO AWS access. So this runs
// under a role that can only GetItem/Query the data table (see infra ViewerRole): even a
// total compromise of this handler cannot publish config, mint a title key or delete a row.
//
// Tenant isolation is not a concern here the way it is in a multi-tenant SaaS — the whole
// deployment belongs to one studio — but the READ boundary still is: a viewer may see
// aggregates, never title keys. `titles()` below returns names and ids only, and no route
// reads the meta row's key hash.

import { DynamoDBClient, QueryCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import {
  SK_COHORT_SIZE,
  SK_DAU,
  SK_SESS_COUNT,
  SK_SESS_SECONDS,
  TITLES_INDEX_PK,
  cohortPk,
  dayPk,
  titlePk,
} from "../../shared/src/keys";
import { issuerFor, jwksUrlFor, verifyIdToken, type JwkKey } from "./jwt";
import { VIEWER_HTML } from "./viewer-page";

export interface UrlEvent {
  rawPath?: string;
  requestContext?: { http?: { method?: string } };
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
}
export interface UrlResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * The exact origin the page must be allowed to reach for sign-in: the issuer minus its
 * `/<poolId>` path. Exported because this one string decides whether sign-in works at all
 * (see the CSP note below) — a wrong value fails only in a browser, which no curl and no
 * server-side test can see.
 */
export function cognitoOrigin(issuer: string): string {
  try {
    return new URL(issuer).origin;
  } catch {
    return "";
  }
}

const json = (statusCode: number, body: unknown): UrlResponse => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

/** ISO day strings, newest last — mirrors the desktop dashboard's window exactly. */
function lastDays(n: number, nowMs: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(nowMs - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

const num = (v: AttributeValue | undefined): number => (v && "N" in v ? Number(v.N) : 0);
const str = (v: AttributeValue | undefined): string => (v && "S" in v ? v.S! : "");

export interface ViewerDeps {
  query(pk: string): Promise<Record<string, AttributeValue>[]>;
  /** Cognito's signing keys for this pool. Cached across invocations by the caller. */
  keys(): Promise<JwkKey[]>;
  issuer: string;
  audience: string;
  now(): number;
}

/**
 * Build the handler. Everything AWS-shaped is injected, so the tests below exercise the
 * real routing and the real auth decisions without a network or a table.
 */
export function makeViewerHandler(deps: ViewerDeps) {
  async function authorize(event: UrlEvent): Promise<{ ok: true } | { ok: false; res: UrlResponse }> {
    const raw = event.headers?.authorization ?? event.headers?.Authorization ?? "";
    const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
    if (!token) return { ok: false, res: json(401, { error: "Sign in to view this dashboard." }) };
    const result = verifyIdToken(token, {
      keys: await deps.keys(),
      issuer: deps.issuer,
      audience: deps.audience,
      now: Math.floor(deps.now() / 1000),
    });
    if ("error" in result) {
      // The reason is deliberately NOT echoed: a caller probing this endpoint learns only
      // that the token was rejected, never which check caught it.
      return { ok: false, res: json(401, { error: "Your session has expired — please sign in again." }) };
    }
    return { ok: true };
  }

  async function titles(): Promise<{ titleId: string; name: string }[]> {
    const items = await deps.query(TITLES_INDEX_PK);
    return items
      .map((i) => ({ titleId: str(i.sk).replace(/^title#/, ""), name: str(i.name) }))
      .filter((t) => t.titleId);
  }

  async function overview(titleId: string, days: number) {
    const dayList = lastDays(days, deps.now());
    const partitions = await Promise.all(dayList.map((d) => deps.query(dayPk(titleId, d))));

    const events = new Map<string, number>();
    const platforms = new Map<string, number>();
    const daily = dayList.map((day, i) => {
      let dau = 0;
      let sessions = 0;
      let sessionSeconds = 0;
      let dayEvents = 0;
      for (const item of partitions[i] ?? []) {
        const sk = str(item.sk);
        const n = num(item.n);
        if (sk === SK_DAU) dau = n;
        else if (sk === SK_SESS_COUNT) sessions = n;
        else if (sk === SK_SESS_SECONDS) sessionSeconds = n;
        else if (sk.startsWith("event#")) {
          const name = sk.slice("event#".length);
          events.set(name, (events.get(name) ?? 0) + n);
          dayEvents += n;
        } else if (sk.startsWith("plat#")) {
          const name = sk.slice("plat#".length);
          platforms.set(name, (platforms.get(name) ?? 0) + n);
        }
      }
      return { day, dau, sessions, sessionSeconds, events: dayEvents };
    });

    const top = (m: Map<string, number>) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

    return { days: daily, events: top(events), platforms: top(platforms) };
  }

  /** D1/D7/D30 for the most recent cohorts that are old enough to have a milestone. */
  async function retention(titleId: string) {
    const cohortDays = lastDays(31, deps.now());
    const rows = await Promise.all(cohortDays.map((d) => deps.query(cohortPk(titleId, d))));
    const buckets: Record<string, { returned: number; size: number }> = {
      d1: { returned: 0, size: 0 },
      d7: { returned: 0, size: 0 },
      d30: { returned: 0, size: 0 },
    };
    const ageOf = (day: string) => Math.round((deps.now() - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
    cohortDays.forEach((day, i) => {
      const items = rows[i] ?? [];
      const size = num(items.find((it) => str(it.sk) === SK_COHORT_SIZE)?.n);
      if (!size) return;
      const age = ageOf(day);
      for (const [bucket, minAge] of [
        ["d1", 1],
        ["d7", 7],
        ["d30", 30],
      ] as const) {
        // A cohort too young to have reached the milestone is EXCLUDED, never counted as
        // zero — the same honesty rule the desktop dashboard follows.
        if (age < minAge) continue;
        buckets[bucket]!.size += size;
        buckets[bucket]!.returned += num(items.find((it) => str(it.sk) === bucket)?.n);
      }
    });
    const pct = (b: { returned: number; size: number }) =>
      b.size === 0 ? null : Math.round((b.returned / b.size) * 1000) / 10;
    return { d1: pct(buckets.d1!), d7: pct(buckets.d7!), d30: pct(buckets.d30!) };
  }

  return async function handler(event: UrlEvent): Promise<UrlResponse> {
    const method = event.requestContext?.http?.method ?? "GET";
    const path = (event.rawPath ?? "/").replace(/\/+$/, "") || "/";
    if (method !== "GET") return json(405, { error: "Method not allowed." });

    // The page itself is public — it holds no data, only the login form. Everything it
    // then asks for requires a verified token.
    if (path === "/") {
      return {
        statusCode: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          // The page loads nothing from anywhere else; say so in a header a browser enforces.
          //
          // 🪤 connect-src names the pool's EXACT origin, derived from the issuer. It used
          // to read `https://cognito-idp.*.amazonaws.com`, which is not a legal CSP
          // host-source: a wildcard may only be the LEFT-MOST label (`https://*.example.com`),
          // never an interior one. Browsers discard an invalid source silently — the console
          // says "It will be ignored" and moves on — so connect-src degraded to 'self' alone
          // and every sign-in died as an opaque `TypeError: Failed to fetch`, surfaced as
          // "Couldn't reach the sign-in service". curl could not see it (CSP is enforced by
          // browsers only) and no unit test covered the header, so sign-in shipped broken in
          // EVERY browser (founder, 2026-08-14). The exact origin is also tighter than the
          // wildcard ever intended to be.
          "content-security-policy":
            `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' ${cognitoOrigin(deps.issuer)}`,
          // Never let this page be framed: it carries a sign-in form and a sign-out
          // control, both worth clickjacking. TrafficPoppy's dashboard already sets this;
          // this one had been missing it.
          "x-frame-options": "DENY",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        },
        body: VIEWER_HTML,
      };
    }

    if (path === "/api/config") {
      // What the page needs to talk to Cognito. Public by nature — a pool id and a public
      // client id ship inside every app that uses them.
      return json(200, { issuer: deps.issuer, clientId: deps.audience });
    }

    if (path === "/api/stats") {
      const auth = await authorize(event);
      if (!auth.ok) return auth.res;

      const list = await titles();
      const wanted = event.queryStringParameters?.title;
      const titleId = wanted && list.some((t) => t.titleId === wanted) ? wanted : list[0]?.titleId;
      if (!titleId) return json(200, { titles: [], titleId: null, days: [], events: [], platforms: [] });

      const daysParam = Number(event.queryStringParameters?.days ?? 30);
      const days = [7, 30, 90].includes(daysParam) ? daysParam : 30;
      const [ov, ret] = await Promise.all([overview(titleId, days), retention(titleId)]);
      return json(200, { titles: list, titleId, retention: ret, ...ov });
    }

    return json(404, { error: "Not found." });
  };
}

// ── Lambda entrypoint (template.ts VIEWER_HANDLER = "viewer.handler") ──────────────────
let cachedKeys: JwkKey[] | null = null;

export const handler = async (event: UrlEvent): Promise<UrlResponse> => {
  const tableName = process.env.TABLE_NAME;
  const poolId = process.env.USER_POOL_ID;
  const clientId = process.env.USER_POOL_CLIENT_ID;
  const region = process.env.AWS_REGION ?? "";
  if (!tableName || !poolId || !clientId) throw new Error("viewer: missing environment.");

  const db = new DynamoDBClient({});
  return makeViewerHandler({
    query: async (pk) => {
      const out = await db.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "pk = :p",
          ExpressionAttributeValues: { ":p": { S: pk } },
        }),
      );
      return (out.Items ?? []) as Record<string, AttributeValue>[];
    },
    keys: async () => {
      // Fetched once per container. Cognito rotates rarely, and a cold start re-fetches.
      if (!cachedKeys) {
        const res = await fetch(jwksUrlFor(region, poolId));
        if (!res.ok) throw new Error(`viewer: JWKS fetch failed (${res.status})`);
        cachedKeys = ((await res.json()) as { keys: JwkKey[] }).keys;
      }
      return cachedKeys;
    },
    issuer: issuerFor(region, poolId),
    audience: clientId,
    now: () => Date.now(),
  })(event);
};

// Re-exported so the admin plane and tests share one definition of the titles-index pk.
export { titlePk };
