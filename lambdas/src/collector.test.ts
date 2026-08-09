import { describe, expect, it, vi } from "vitest";
import { sha256Hex, skEvent, type TitleMeta } from "./core";
import { makeHandler, processBatch, type UrlEvent } from "./collector";
import type { Store } from "./store";

const NOW = Date.parse("2026-08-09T12:00:00Z"); // → day 2026-08-09, 43200 s to midnight
const KEY = "valid-key-0123456";

const META: TitleMeta = {
  titleId: "abcd1234",
  name: "My Game",
  salt: "salt-1",
  keyHash: sha256Hex(KEY),
  eventCap: 1000,
  cardCap: 200,
};

/** A fake Store with happy-path defaults; override per test. */
function fakeStore(overrides: Partial<Store> = {}): Store {
  return {
    getTitleMeta: vi.fn(async () => META),
    getCurrentConfig: vi.fn(async () => ({ version: 3, json: '{"speed":2}' })),
    addTotal: vi.fn(async () => 10),
    addCounter: vi.fn(async () => {}),
    putUniq: vi.fn(async () => true),
    getPlayer: vi.fn(async () => null),
    createPlayer: vi.fn(async () => true),
    touchPlayer: vi.fn(async () => {}),
    markRetention: vi.fn(async () => true),
    resolveEventSk: vi.fn(async (_t, _d, name) => skEvent(name)),
    ...overrides,
  };
}

const configGet = (titleId: string, env: string, k?: string, etag?: string): UrlEvent => ({
  rawPath: `/config/${titleId}/${env}`,
  requestContext: { http: { method: "GET" } },
  queryStringParameters: k ? { k } : {},
  headers: etag ? { "if-none-match": etag } : {},
});

const eventsPost = (body: unknown): UrlEvent => ({
  rawPath: "/e",
  requestContext: { http: { method: "POST" } },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const batchBody = (events: { n: string; v?: number }[]) => ({
  t: "abcd1234",
  k: KEY,
  s: { iid: "install-id-0001", sid: "sess-1", plat: "iOS", ver: "1.2.0" },
  e: events,
});

describe("GET /config", () => {
  it("404s a bad env, 403s unknown titles and wrong keys identically", async () => {
    const store = fakeStore();
    const handler = makeHandler(store, () => NOW);
    expect((await handler(configGet("abcd1234", "staging", KEY))).statusCode).toBe(404);

    const missing = makeHandler(fakeStore({ getTitleMeta: vi.fn(async () => null) }), () => NOW);
    const noTitle = await missing(configGet("abcd1234", "prod", KEY));
    const badKey = await makeHandler(store, () => NOW)(configGet("abcd1234", "prod", "wrong-key-000000"));
    expect(noTitle.statusCode).toBe(403);
    expect(badKey.statusCode).toBe(403);
    expect(noTitle.body).toBe(badKey.body); // no title enumeration via error shape
  });

  it("serves the config with ETag + cache headers", async () => {
    const handler = makeHandler(fakeStore(), () => NOW);
    const res = await handler(configGet("abcd1234", "prod", KEY));
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"v3"');
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    expect(JSON.parse(res.body)).toEqual({ v: 3, config: { speed: 2 } });
  });

  it("answers 304 with no body on a matching If-None-Match", async () => {
    const handler = makeHandler(fakeStore(), () => NOW);
    const res = await handler(configGet("abcd1234", "prod", KEY, '"v3"'));
    expect(res.statusCode).toBe(304);
    expect(res.body).toBe("");
    expect(res.headers.etag).toBe('"v3"');
  });

  it("serves {v:0, config:{}} for a never-published env — a boot must not break", async () => {
    const handler = makeHandler(
      fakeStore({ getCurrentConfig: vi.fn(async () => ({ version: 0, json: "{}" })) }),
      () => NOW,
    );
    const res = await handler(configGet("abcd1234", "dev", KEY));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ v: 0, config: {} });
  });
});

describe("POST /e — gates", () => {
  it("400s bad JSON, 403s a wrong key", async () => {
    const handler = makeHandler(fakeStore(), () => NOW);
    expect((await handler(eventsPost("{not json"))).statusCode).toBe(400);
    const bad = batchBody([{ n: "session_start" }]);
    bad.k = "wrong-key-000000";
    expect((await handler(eventsPost(bad))).statusCode).toBe(403);
  });

  it("429s past the cap with Retry-After to UTC midnight, before any counter fan-out", async () => {
    const store = fakeStore({ addTotal: vi.fn(async () => 1001) }); // cap is 1000
    const handler = makeHandler(store, () => NOW);
    const res = await handler(eventsPost(batchBody([{ n: "session_start" }])));
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("43200");
    expect(JSON.parse(res.body).retryAfter).toBe(43200);
    expect(store.addCounter).not.toHaveBeenCalled();
    expect(store.putUniq).not.toHaveBeenCalled();
  });

  it("decodes base64 bodies (Function URLs deliver POSTs that way)", async () => {
    const handler = makeHandler(fakeStore(), () => NOW);
    const res = await handler({
      rawPath: "/e",
      requestContext: { http: { method: "POST" } },
      body: Buffer.from(JSON.stringify(batchBody([{ n: "session_start" }]))).toString("base64"),
      isBase64Encoded: true,
    });
    expect(res.statusCode).toBe(202);
  });

  it("404s unknown routes and answers 500 without internals when the store throws", async () => {
    const handler = makeHandler(fakeStore(), () => NOW);
    expect((await handler({ rawPath: "/nope", requestContext: { http: { method: "GET" } } })).statusCode).toBe(404);

    const broken = makeHandler(
      fakeStore({ getTitleMeta: vi.fn(async () => Promise.reject(new Error("secret detail"))) }),
      () => NOW,
    );
    const res = await broken(eventsPost(batchBody([{ n: "session_start" }])));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret detail");
  });
});

describe("POST /e — the happy path writes every counter family", () => {
  it("routes customs, sessions, platform/version, DAU, cohort size", async () => {
    const store = fakeStore();
    const handler = makeHandler(store, () => NOW);
    const res = await handler(
      eventsPost(
        batchBody([
          { n: "session_start" },
          { n: "level_won", v: 3 },
          { n: "session_end", v: 300 },
        ]),
      ),
    );
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ ok: true, accepted: 3 });

    expect(store.addTotal).toHaveBeenCalledWith("abcd1234", "2026-08-09", 3);
    const day = "day#abcd1234#2026-08-09";
    const counters = (store.addCounter as ReturnType<typeof vi.fn>).mock.calls;
    expect(counters).toContainEqual([day, "event#level_won", 1]);
    expect(counters).toContainEqual([day, "sess#count", 1]);
    expect(counters).toContainEqual([day, "sess#seconds", 300]);
    expect(counters).toContainEqual([day, "plat#ios", 1]);
    expect(counters).toContainEqual([day, "ver#1.2.0", 1]);
    expect(counters).toContainEqual([day, "dau", 1]); // putUniq returned true
    expect(counters).toContainEqual(["cohort#abcd1234#2026-08-09", "size", 1]); // new player
  });

  it("skips the DAU counter when the player already counted today", async () => {
    const store = fakeStore({ putUniq: vi.fn(async () => false) });
    await makeHandler(store, () => NOW)(eventsPost(batchBody([{ n: "session_start" }])));
    const counters = (store.addCounter as ReturnType<typeof vi.fn>).mock.calls;
    expect(counters.find((c: unknown[]) => c[1] === "dau")).toBeUndefined();
  });
});

describe("processBatch — retention", () => {
  const batch = {
    titleId: "abcd1234",
    key: KEY,
    session: { iid: "install-id-0001", sid: "s", platform: "ios", appVersion: "1.2.0" },
    events: [{ n: "session_start" }],
  };

  it("marks d7 against the FIRST-SEEN cohort for a day-7 return", async () => {
    const store = fakeStore({
      getPlayer: vi.fn(async () => ({ firstSeen: "2026-08-02" })), // 7 days before NOW's day
    });
    await processBatch(store, META, batch, NOW);
    expect(store.markRetention).toHaveBeenCalledWith("abcd1234", expect.any(String), "d7");
    const counters = (store.addCounter as ReturnType<typeof vi.fn>).mock.calls;
    expect(counters).toContainEqual(["cohort#abcd1234#2026-08-02", "d7", 1]);
    expect(store.touchPlayer).toHaveBeenCalled();
  });

  it("does NOT double-count when the retention flag was already set", async () => {
    const store = fakeStore({
      getPlayer: vi.fn(async () => ({ firstSeen: "2026-08-08" })), // day 1
      markRetention: vi.fn(async () => false),
    });
    await processBatch(store, META, batch, NOW);
    const counters = (store.addCounter as ReturnType<typeof vi.fn>).mock.calls;
    expect(counters.find((c: unknown[]) => String(c[0]).startsWith("cohort#") && c[1] === "d1")).toBeUndefined();
  });

  it("does nothing retention-ish on an off-bucket day (day 3)", async () => {
    const store = fakeStore({
      getPlayer: vi.fn(async () => ({ firstSeen: "2026-08-06" })),
    });
    await processBatch(store, META, batch, NOW);
    expect(store.markRetention).not.toHaveBeenCalled();
  });

  it("recovers the firstSeen from the winner after losing the create race", async () => {
    const getPlayer = vi
      .fn()
      .mockResolvedValueOnce(null) // first look: not there
      .mockResolvedValueOnce({ firstSeen: "2026-08-08" }); // read-back after lost race
    const store = fakeStore({ getPlayer, createPlayer: vi.fn(async () => false) });
    await processBatch(store, META, batch, NOW);
    expect(store.markRetention).toHaveBeenCalledWith("abcd1234", expect.any(String), "d1");
  });
});
