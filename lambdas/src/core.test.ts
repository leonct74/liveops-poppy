import { describe, expect, it } from "vitest";
import {
  capExceeded,
  cfgPk,
  cfgVersionSk,
  clampSessionSeconds,
  cohortPk,
  DEFAULT_CARD_CAP,
  DEFAULT_EVENT_CAP,
  dayPk,
  daysBetween,
  etagFor,
  eventSkFor,
  expiryEpoch,
  isValidEnv,
  keyMatches,
  MAX_BATCH,
  MAX_BODY_BYTES,
  parseBatch,
  planBatch,
  playerHash,
  playerPk,
  retentionBucket,
  sanitizeSegment,
  secondsToUtcMidnight,
  sha256Hex,
  SK_CARD,
  SK_CURRENT,
  SK_DAU,
  SK_META,
  SK_OTHER,
  SK_SESS_COUNT,
  SK_SESS_SECONDS,
  SK_TOTAL,
  skEvent,
  skPlat,
  skVer,
  titlePk,
  uniqPk,
  utcDay,
  validateConfigDoc,
} from "./core";

// ── The public schema contract: every literal locked on purpose ───────────────────────
describe("key literals (public contract — IMPLEMENTATION.md §3)", () => {
  it("locks every pk/sk shape", () => {
    expect(titlePk("abc12345")).toBe("title#abc12345");
    expect(SK_META).toBe("meta");
    expect(cfgPk("abc12345", "prod")).toBe("cfg#abc12345#prod");
    expect(cfgVersionSk(42)).toBe("v#000042");
    expect(SK_CURRENT).toBe("current");
    expect(dayPk("abc12345", "2026-08-09")).toBe("day#abc12345#2026-08-09");
    expect(uniqPk("abc12345", "2026-08-09")).toBe("uniq#abc12345#2026-08-09");
    expect(playerPk("abc12345")).toBe("player#abc12345");
    expect(cohortPk("abc12345", "2026-08-01")).toBe("cohort#abc12345#2026-08-01");
    expect(SK_TOTAL).toBe("total#events");
    expect(skEvent("level_won")).toBe("event#level_won");
    expect(SK_OTHER).toBe("event#__other");
    expect(SK_CARD).toBe("card#names");
    expect(SK_SESS_COUNT).toBe("sess#count");
    expect(SK_SESS_SECONDS).toBe("sess#seconds");
    expect(SK_DAU).toBe("dau");
    expect(skPlat("ios")).toBe("plat#ios");
    expect(skVer("1.2.0")).toBe("ver#1.2.0");
  });

  it("zero-pads config versions so lexicographic sk order = numeric order", () => {
    expect(cfgVersionSk(1) < cfgVersionSk(2)).toBe(true);
    expect(cfgVersionSk(9) < cfgVersionSk(10)).toBe(true);
    expect(cfgVersionSk(99999) < cfgVersionSk(100000)).toBe(true);
  });
});

// ── parseBatch ─────────────────────────────────────────────────────────────────────────
const validBody = () =>
  JSON.stringify({
    t: "abcd1234",
    k: "k".repeat(16),
    s: { iid: "0f8b7c6d-1234", sid: "sess-1", plat: "iOS", ver: "1.2.0" },
    e: [{ n: "session_start" }, { n: "level_won", v: 3 }],
  });

describe("parseBatch", () => {
  it("accepts a valid batch and sanitises platform/version", () => {
    const r = parseBatch(validBody());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.batch.titleId).toBe("abcd1234");
    expect(r.batch.session.platform).toBe("ios"); // lowercased
    expect(r.batch.session.appVersion).toBe("1.2.0");
    expect(r.batch.events).toEqual([{ n: "session_start" }, { n: "level_won", v: 3 }]);
  });

  it("rejects oversized bodies with 413 BEFORE parsing", () => {
    const r = parseBatch("x".repeat(MAX_BODY_BYTES + 1));
    expect(r).toMatchObject({ ok: false, status: 413 });
  });

  it("rejects non-JSON with 400", () => {
    expect(parseBatch("not json{")).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects a malformed title id", () => {
    const bad = JSON.parse(validBody());
    bad.t = "Has-Caps!";
    expect(parseBatch(JSON.stringify(bad))).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects a short key", () => {
    const bad = JSON.parse(validBody());
    bad.k = "short";
    expect(parseBatch(JSON.stringify(bad))).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects a missing/short install id", () => {
    const bad = JSON.parse(validBody());
    bad.s.iid = "abc";
    expect(parseBatch(JSON.stringify(bad))).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects empty and oversized batches", () => {
    const bad = JSON.parse(validBody());
    bad.e = [];
    expect(parseBatch(JSON.stringify(bad))).toMatchObject({ ok: false, status: 400 });
    bad.e = Array.from({ length: MAX_BATCH + 1 }, () => ({ n: "x" }));
    expect(parseBatch(JSON.stringify(bad))).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects bad event names and non-finite values", () => {
    const bad = JSON.parse(validBody());
    bad.e = [{ n: "Bad-Name" }];
    expect(parseBatch(JSON.stringify(bad))).toMatchObject({ ok: false, status: 400 });
    bad.e = [{ n: "fine", v: "NaN-ish" }];
    expect(parseBatch(JSON.stringify(bad))).toMatchObject({ ok: false, status: 400 });
  });
});

describe("sanitizeSegment", () => {
  it("lowercases, strips, truncates, and never rejects", () => {
    expect(sanitizeSegment("Windows NT 10.0; Win64")).toBe("windowsnt10.0win64");
    expect(sanitizeSegment("")).toBe("unknown");
    expect(sanitizeSegment(undefined)).toBe("unknown");
    expect(sanitizeSegment("™®©")).toBe("unknown");
    expect(sanitizeSegment("a".repeat(64)).length).toBe(32);
  });
});

// ── Identity & keys ────────────────────────────────────────────────────────────────────
describe("keyMatches", () => {
  const key = "the-real-title-key-123";
  const meta = { keyHash: sha256Hex(key) };

  it("accepts the right key and refuses a wrong one", () => {
    expect(keyMatches(key, meta)).toBe(true);
    expect(keyMatches("the-real-title-key-124", meta)).toBe(false);
  });

  it("honours the OLD key during a rotation grace window", () => {
    const rotated = { keyHash: sha256Hex("new-key-after-rotation"), keyHash2: sha256Hex(key) };
    expect(keyMatches(key, rotated)).toBe(true);
    expect(keyMatches("new-key-after-rotation", rotated)).toBe(true);
    expect(keyMatches("neither", rotated)).toBe(false);
  });
});

describe("playerHash", () => {
  it("is stable per (salt, installId) and differs across titles (different salts)", () => {
    expect(playerHash("saltA", "iid-1")).toBe(playerHash("saltA", "iid-1"));
    expect(playerHash("saltA", "iid-1")).not.toBe(playerHash("saltB", "iid-1"));
  });
});

// ── Time ───────────────────────────────────────────────────────────────────────────────
describe("time helpers", () => {
  it("buckets to UTC days", () => {
    expect(utcDay(Date.parse("2026-08-09T23:59:59Z"))).toBe("2026-08-09");
    expect(utcDay(Date.parse("2026-08-10T00:00:00Z"))).toBe("2026-08-10");
  });

  it("computes day distances", () => {
    expect(daysBetween("2026-08-01", "2026-08-02")).toBe(1);
    expect(daysBetween("2026-08-01", "2026-08-31")).toBe(30);
    expect(daysBetween("2026-08-01", "2026-08-01")).toBe(0);
  });

  it("computes Retry-After to the next UTC midnight", () => {
    expect(secondsToUtcMidnight(Date.parse("2026-08-09T23:59:00Z"))).toBe(60);
    expect(secondsToUtcMidnight(Date.parse("2026-08-09T00:00:00Z"))).toBe(86_400);
  });

  it("computes TTL epochs in seconds", () => {
    expect(expiryEpoch(1_000_000_000_000, 1)).toBe(1_000_000_000 + 86_400);
  });
});

describe("retentionBucket (classic day-N)", () => {
  it("maps exactly day 1/7/30 and nothing else", () => {
    expect(retentionBucket(0)).toBeNull();
    expect(retentionBucket(1)).toBe("d1");
    expect(retentionBucket(2)).toBeNull();
    expect(retentionBucket(7)).toBe("d7");
    expect(retentionBucket(8)).toBeNull();
    expect(retentionBucket(30)).toBe("d30");
    expect(retentionBucket(31)).toBeNull();
  });
});

// ── Config plane ───────────────────────────────────────────────────────────────────────
describe("config helpers", () => {
  it("quotes ETags and validates envs", () => {
    expect(etagFor(42)).toBe('"v42"');
    expect(isValidEnv("prod")).toBe(true);
    expect(isValidEnv("dev")).toBe(true);
    expect(isValidEnv("staging")).toBe(false);
  });

  it("validates config documents", () => {
    expect(validateConfigDoc("{}")).toEqual({ ok: true });
    expect(validateConfigDoc('{"speed":1.5}')).toEqual({ ok: true });
    expect(validateConfigDoc("not json").ok).toBe(false);
    expect(validateConfigDoc("[1,2]").ok).toBe(false);
    expect(validateConfigDoc("42").ok).toBe(false);
    expect(validateConfigDoc(`{"pad":"${"x".repeat(65 * 1024)}"}`).ok).toBe(false);
  });
});

// ── Batch planning ─────────────────────────────────────────────────────────────────────
describe("planBatch", () => {
  it("splits reserved session events from custom counters", () => {
    const plan = planBatch([
      { n: "session_start" },
      { n: "level_won", v: 3 },
      { n: "level_won" },
      { n: "session_end", v: 300.4 },
    ]);
    expect(plan.totalEvents).toBe(4); // cap counts EVERYTHING — reserved events aren't free
    expect(plan.sessionStarts).toBe(1);
    expect(plan.sessionEndSeconds).toEqual([300]);
    expect(plan.customCounts.get("level_won")).toBe(2);
    expect(plan.customCounts.has("session_start")).toBe(false);
  });

  it("ignores a session_end without a value and clamps absurd ones", () => {
    const plan = planBatch([{ n: "session_end" }, { n: "session_end", v: 999_999 }, { n: "session_end", v: -5 }]);
    expect(plan.sessionEndSeconds).toEqual([86_400, 0]);
  });
});

describe("cardinality guard", () => {
  it("routes existing names to their counter, caps new ones into __other", () => {
    expect(eventSkFor("seen_before", false, 500, DEFAULT_CARD_CAP)).toBe("event#seen_before");
    expect(eventSkFor("fresh", true, 10, DEFAULT_CARD_CAP)).toBe("event#fresh");
    expect(eventSkFor("fresh", true, DEFAULT_CARD_CAP, DEFAULT_CARD_CAP)).toBe(SK_OTHER);
  });
});

describe("capExceeded", () => {
  it("triggers strictly past the cap", () => {
    expect(capExceeded(DEFAULT_EVENT_CAP, DEFAULT_EVENT_CAP)).toBe(false);
    expect(capExceeded(DEFAULT_EVENT_CAP + 1, DEFAULT_EVENT_CAP)).toBe(true);
  });
});
