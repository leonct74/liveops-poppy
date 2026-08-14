// Routing + authorisation for the team dashboard. The auth decisions matter most: this
// endpoint is public HTTPS, so "who gets numbers" is decided here and nowhere else.
import { describe, expect, it, vi } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import { makeViewerHandler, type UrlEvent } from "./viewer";
import { issuerFor, type JwkKey } from "./jwt";
import { SK_COHORT_SIZE, SK_DAU, SK_SESS_COUNT, SK_SESS_SECONDS, TITLES_INDEX_PK, cohortPk, dayPk } from "../../shared/src/keys";

const ISSUER = issuerFor("eu-west-1", "eu-west-1_POOL");
const CLIENT = "client-1";
const NOW = Date.UTC(2026, 7, 11, 12, 0, 0);
const today = new Date(NOW).toISOString().slice(0, 10);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as unknown as { n: string; e: string };
const KEYS: JwkKey[] = [{ kid: "k1", kty: "RSA", n: jwk.n, e: jwk.e }];

function token(over: Record<string, unknown> = {}): string {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1" })).toString("base64url");
  const p = Buffer.from(
    JSON.stringify({
      iss: ISSUER, aud: CLIENT, token_use: "id", sub: "u1", email: "producer@studio.example",
      exp: Math.floor(NOW / 1000) + 3600, iat: Math.floor(NOW / 1000) - 10, ...over,
    }),
  ).toString("base64url");
  const s = createSign("RSA-SHA256");
  s.update(`${h}.${p}`);
  s.end();
  return `${h}.${p}.${s.sign(privateKey).toString("base64url")}`;
}

const N = (n: number) => ({ N: String(n) });
const S = (s: string) => ({ S: s });

function deps(over: Partial<Parameters<typeof makeViewerHandler>[0]> = {}) {
  const data: Record<string, Record<string, any>[]> = {
    [TITLES_INDEX_PK]: [{ sk: S("title#game1"), name: S("Sunken Keep") }],
    [dayPk("game1", today)]: [
      { sk: S(SK_DAU), n: N(120) },
      { sk: S(SK_SESS_COUNT), n: N(200) },
      { sk: S(SK_SESS_SECONDS), n: N(60_000) },
      { sk: S("event#level_complete"), n: N(900) },
      { sk: S("plat#web"), n: N(120) },
    ],
    // A cohort from 8 days ago: old enough for d1 and d7, not d30.
    [cohortPk("game1", new Date(NOW - 8 * 86_400_000).toISOString().slice(0, 10))]: [
      { sk: S(SK_COHORT_SIZE), n: N(100) },
      { sk: S("d1"), n: N(40) },
      { sk: S("d7"), n: N(20) },
    ],
  };
  return {
    query: vi.fn(async (pk: string) => data[pk] ?? []),
    keys: vi.fn(async () => KEYS),
    issuer: ISSUER,
    audience: CLIENT,
    now: () => NOW,
    ...over,
  };
}

const get = (path: string, headers: Record<string, string> = {}, query?: Record<string, string>): UrlEvent => ({
  rawPath: path,
  requestContext: { http: { method: "GET" } },
  headers,
  queryStringParameters: query,
});

describe("viewer handler", () => {
  it("serves the dashboard page unauthenticated — it holds no data, only the login form", async () => {
    const res = await makeViewerHandler(deps())(get("/"));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Game dashboard");
    // The page must never carry numbers: those come from the authorised API.
    expect(res.body).not.toContain("Sunken Keep");
  });

  /**
   * 🪤 The CSP must actually PERMIT the pool's origin, or sign-in is impossible in every
   * browser while looking perfect from curl. It shipped reading
   * `https://cognito-idp.*.amazonaws.com` — illegal, because a CSP wildcard may only be the
   * left-most label. Browsers discard an invalid source with a console note and carry on,
   * so connect-src silently became 'self' alone and every sign-in died as an opaque
   * `TypeError: Failed to fetch` (founder, 2026-08-14). Asserting the literal origin is the
   * point: a wildcard here is the bug.
   */
  it("allows the page to reach THIS pool's Cognito origin, with no wildcard", async () => {
    const res = await makeViewerHandler(deps())(get("/"));
    const csp = res.headers["content-security-policy"] ?? "";
    const connect = csp.split(";").find((d) => d.trim().startsWith("connect-src")) ?? "";
    expect(connect).toContain(new URL(ISSUER).origin);
    // An interior wildcard matches nothing and is silently dropped — never ship one.
    expect(connect).not.toContain("*");
    // Everything else stays shut.
    expect(csp).toContain("default-src 'none'");
  });

  /**
   * 🪤 A failing read must never look like an empty game. This used to throw out of the
   * handler as an opaque 502, which the page rendered as zeros — the founder saw "no data"
   * and had no way to tell a broken backend from a quiet one (2026-08-14).
   */
  it("reports a failed read as an error instead of rendering as no data", async () => {
    const boom = deps({
      query: async () => {
        throw new Error("AccessDeniedException: not authorized to Query");
      },
    });
    const res = await makeViewerHandler(boom)(get("/api/stats", { authorization: `Bearer ${token()}` }));
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toBeTruthy();
    // The viewer is told there IS a problem, never what it is.
    expect(res.body).not.toContain("AccessDenied");
    // Crucially it is NOT a 200 carrying empty arrays, which is what read as "no data".
    expect(body.days).toBeUndefined();
  });

  it("ships a favicon inline and refuses to be framed", async () => {
    const res = await makeViewerHandler(deps())(get("/"));
    // One Lambda route serves this page, so a /favicon.ico link would 404 every visit.
    expect(res.body).toContain('rel="icon" href="data:image/png;base64,');
    // A sign-in form must never be frameable.
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("REFUSES stats without a token", async () => {
    const res = await makeViewerHandler(deps())(get("/api/stats"));
    expect(res.statusCode).toBe(401);
    expect(await JSON.parse(res.body).error).toMatch(/sign in/i);
  });

  it("REFUSES an expired token, and never says which check failed", async () => {
    const d = deps();
    const res = await makeViewerHandler(d)(
      get("/api/stats", { authorization: `Bearer ${token({ exp: Math.floor(NOW / 1000) - 5 })}` }),
    );
    expect(res.statusCode).toBe(401);
    // No probing oracle: the body must not name the failure.
    expect(res.body).not.toMatch(/expired token|signature|issuer|audience|kid/i);
    expect(d.query).not.toHaveBeenCalled(); // and it must not touch the table
  });

  it("REFUSES a token from another pool or another client", async () => {
    const h = makeViewerHandler(deps());
    for (const bad of [{ iss: issuerFor("eu-west-1", "eu-west-1_OTHER") }, { aud: "other-client" }]) {
      const res = await h(get("/api/stats", { authorization: `Bearer ${token(bad)}` }));
      expect(res.statusCode).toBe(401);
    }
  });

  it("serves the numbers to a verified viewer", async () => {
    const res = await makeViewerHandler(deps())(get("/api/stats", { authorization: `Bearer ${token()}` }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.titles).toEqual([{ titleId: "game1", name: "Sunken Keep" }]);
    expect(body.days.at(-1)).toMatchObject({ day: today, dau: 120, sessions: 200, events: 900 });
    expect(body.events).toEqual([{ name: "level_complete", count: 900 }]);
    expect(body.platforms).toEqual([{ name: "web", count: 120 }]);
  });

  it("excludes cohorts too young for a milestone rather than scoring them zero", async () => {
    const res = await makeViewerHandler(deps())(get("/api/stats", { authorization: `Bearer ${token()}` }));
    const { retention } = JSON.parse(res.body);
    expect(retention.d1).toBe(40); // 40/100
    expect(retention.d7).toBe(20); // 20/100
    expect(retention.d30).toBeNull(); // the cohort is 8 days old — not 0%, but unknown
  });

  it("never exposes a title KEY — a viewer may read numbers, never credentials", async () => {
    const d = deps({
      query: vi.fn(async (pk: string) =>
        pk === TITLES_INDEX_PK
          ? [{ sk: S("title#game1"), name: S("Sunken Keep"), keyHash: S("SECRET-HASH"), salt: S("SECRET-SALT") }]
          : [],
      ),
    });
    const res = await makeViewerHandler(d)(get("/api/stats", { authorization: `Bearer ${token()}` }));
    expect(res.body).not.toContain("SECRET-HASH");
    expect(res.body).not.toContain("SECRET-SALT");
  });

  it("ignores an unknown title id instead of trusting the query string", async () => {
    const res = await makeViewerHandler(deps())(
      get("/api/stats", { authorization: `Bearer ${token()}` }, { title: "../../etc/passwd" }),
    );
    expect(JSON.parse(res.body).titleId).toBe("game1");
  });

  it("clamps the window to the offered choices", async () => {
    const query = vi.fn(async () => [] as Record<string, any>[]);
    await makeViewerHandler(deps({ query }))(
      get("/api/stats", { authorization: `Bearer ${token()}` }, { days: "9999" }),
    );
    // 30-day default + 31 cohort days + 1 titles query — never 9999 partitions.
    expect(query.mock.calls.length).toBeLessThan(70);
  });

  it("publishes only the public Cognito ids to the page", async () => {
    const res = await makeViewerHandler(deps())(get("/api/config"));
    expect(JSON.parse(res.body)).toEqual({ issuer: ISSUER, clientId: CLIENT });
  });

  it("refuses non-GET and unknown paths", async () => {
    const h = makeViewerHandler(deps());
    const post = await h({ ...get("/api/stats"), requestContext: { http: { method: "POST" } } });
    expect(post.statusCode).toBe(405);
    expect((await h(get("/nope"))).statusCode).toBe(404);
  });
});
