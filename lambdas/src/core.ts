// LiveOpsPoppy core — every pure decision the collector makes, with zero AWS imports so
// all of it unit-tests in milliseconds. store.ts applies these decisions to DynamoDB.
//
// ⚠️ The pk/sk literals below are the PUBLIC schema contract (IMPLEMENTATION.md §3):
// studios point their own BI tools at the table, so changing a key shape is a breaking
// schema change, not a refactor. core.test.ts locks every literal on purpose.

import { createHash, timingSafeEqual } from "node:crypto";

// ── Limits (DESIGN.md §5 — the bill-protection knobs) ─────────────────────────────────
export const MAX_BATCH = 25;
export const MAX_BODY_BYTES = 32 * 1024;
export const EVENT_NAME_RE = /^[a-z0-9_]{1,64}$/;
export const TITLE_ID_RE = /^[a-z0-9]{4,32}$/;
export const MAX_CONFIG_BYTES = 64 * 1024;
export const DEFAULT_EVENT_CAP = 500_000; // events/day/title — enforced, real-time
export const DEFAULT_CARD_CAP = 200; // distinct custom event names/day/title — approximate
export const UNIQ_TTL_DAYS = 40; // DAU hash rows age out (privacy: pseudonymous, not kept)
export const PLAYER_TTL_DAYS = 396; // ~13 months of inactivity → the player row expires
export const ENVS = ["dev", "prod"] as const;
export type Env = (typeof ENVS)[number];
export const CONFIG_MAX_AGE_S = 60; // client + in-Lambda cache horizon for config reads

/** Event names the SDK owns; they drive sessions/retention and never become custom counters. */
export const RESERVED_EVENTS = new Set(["session_start", "session_end"]);

// ── Key literals (the public contract — see the header warning) ───────────────────────
export const SK_META = "meta";
export const SK_CURRENT = "current";
export const SK_TOTAL = "total#events";
export const SK_OTHER = "event#__other";
export const SK_CARD = "card#names";
export const SK_SESS_COUNT = "sess#count";
export const SK_SESS_SECONDS = "sess#seconds";
export const SK_DAU = "dau";

export const titlePk = (titleId: string): string => `title#${titleId}`;
export const cfgPk = (titleId: string, env: Env): string => `cfg#${titleId}#${env}`;
export const cfgVersionSk = (version: number): string => `v#${String(version).padStart(6, "0")}`;
export const dayPk = (titleId: string, day: string): string => `day#${titleId}#${day}`;
export const uniqPk = (titleId: string, day: string): string => `uniq#${titleId}#${day}`;
export const playerPk = (titleId: string): string => `player#${titleId}`;
export const cohortPk = (titleId: string, firstSeenDay: string): string => `cohort#${titleId}#${firstSeenDay}`;
export const skEvent = (name: string): string => `event#${name}`;
export const skPlat = (platform: string): string => `plat#${platform}`;
export const skVer = (version: string): string => `ver#${version}`;

// ── Types ──────────────────────────────────────────────────────────────────────────────
export interface TitleMeta {
  titleId: string;
  name: string;
  /** Per-title STABLE salt for player pseudonymisation (DESIGN.md §6 — retention needs
   * cross-day identity; never present this as TrafficPoppy-style anonymity). */
  salt: string;
  /** sha256 hex of the title key — the key itself is shown once and never stored. */
  keyHash: string;
  /** Set during rotation: the OLD key's hash, honoured for the grace window. */
  keyHash2?: string;
  eventCap: number;
  cardCap: number;
}

export interface SessionInfo {
  /** Random install id the SDK generated — the only cross-day identifier that exists. */
  iid: string;
  /** Session id, fresh per boot. */
  sid: string;
  platform: string;
  appVersion: string;
}

export interface GameEvent {
  n: string;
  /** Optional numeric value; session_end carries the session length in seconds here. */
  v?: number;
}

export interface EventBatch {
  titleId: string;
  key: string;
  session: SessionInfo;
  events: GameEvent[];
}

export type ParseResult = { ok: true; batch: EventBatch } | { ok: false; status: number; error: string };

// ── Validation ─────────────────────────────────────────────────────────────────────────

/** Lowercased [a-z0-9._-], ≤32 chars, or "unknown" — platform/appVersion are sanitised,
 * never rejected: a weird UA string must not cost a game its telemetry. */
export function sanitizeSegment(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 32);
  return cleaned.length > 0 ? cleaned : "unknown";
}

/**
 * Parse + validate a POST /e body. Strict on shape (bad clients fail loudly in
 * development), lenient on free-text fields (sanitised, not rejected).
 */
export function parseBatch(body: string): ParseResult {
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: `Body exceeds ${MAX_BODY_BYTES} bytes.` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, status: 400, error: "Body is not valid JSON." };
  }
  const o = raw as { t?: unknown; k?: unknown; s?: unknown; e?: unknown };
  if (typeof o?.t !== "string" || !TITLE_ID_RE.test(o.t)) {
    return { ok: false, status: 400, error: "Missing or malformed title id (t)." };
  }
  if (typeof o.k !== "string" || o.k.length < 8 || o.k.length > 128) {
    return { ok: false, status: 400, error: "Missing or malformed title key (k)." };
  }
  const s = o.s as { iid?: unknown; sid?: unknown; plat?: unknown; ver?: unknown } | undefined;
  if (typeof s?.iid !== "string" || s.iid.length < 8 || s.iid.length > 64 || !/^[A-Za-z0-9-]+$/.test(s.iid)) {
    return { ok: false, status: 400, error: "Missing or malformed install id (s.iid)." };
  }
  if (typeof s.sid !== "string" || s.sid.length < 4 || s.sid.length > 64) {
    return { ok: false, status: 400, error: "Missing or malformed session id (s.sid)." };
  }
  if (!Array.isArray(o.e) || o.e.length < 1 || o.e.length > MAX_BATCH) {
    return { ok: false, status: 400, error: `Events (e) must be an array of 1–${MAX_BATCH}.` };
  }
  const events: GameEvent[] = [];
  for (const entry of o.e) {
    const ev = entry as { n?: unknown; v?: unknown };
    if (typeof ev?.n !== "string" || !EVENT_NAME_RE.test(ev.n)) {
      return { ok: false, status: 400, error: "Event names must match [a-z0-9_]{1,64}." };
    }
    if (ev.v !== undefined && (typeof ev.v !== "number" || !Number.isFinite(ev.v))) {
      return { ok: false, status: 400, error: "Event value (v) must be a finite number when present." };
    }
    events.push(ev.v === undefined ? { n: ev.n } : { n: ev.n, v: ev.v });
  }
  return {
    ok: true,
    batch: {
      titleId: o.t,
      key: o.k,
      session: {
        iid: s.iid,
        sid: s.sid,
        platform: sanitizeSegment(s.plat),
        appVersion: sanitizeSegment(s.ver),
      },
      events,
    },
  };
}

// ── Keys & identity ────────────────────────────────────────────────────────────────────

export const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");

/** Constant-time compare of the presented key against the stored hash(es) — during a
 * rotation grace window the OLD key's hash is honoured too. */
export function keyMatches(candidate: string, meta: Pick<TitleMeta, "keyHash" | "keyHash2">): boolean {
  const candidateHash = Buffer.from(sha256Hex(candidate), "hex");
  for (const stored of [meta.keyHash, meta.keyHash2]) {
    if (!stored) continue;
    const storedBuf = Buffer.from(stored, "hex");
    if (storedBuf.length === candidateHash.length && timingSafeEqual(storedBuf, candidateHash)) return true;
  }
  return false;
}

/** The ONLY identifier ever stored for a player: sha256(titleSalt + installId). */
export const playerHash = (salt: string, installId: string): string => sha256Hex(salt + installId);

// ── Time ───────────────────────────────────────────────────────────────────────────────

/** UTC day bucket. The caller passes the SERVER receive time explicitly — never let a
 * data-affecting value default to `new Date()` at a distance (MailPoppy idempotency rule). */
export const utcDay = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

export function daysBetween(dayA: string, dayB: string): number {
  return Math.round((Date.parse(`${dayB}T00:00:00Z`) - Date.parse(`${dayA}T00:00:00Z`)) / 86_400_000);
}

/** Seconds until the next UTC midnight — the Retry-After for a capped title. */
export function secondsToUtcMidnight(epochMs: number): number {
  const next = Date.parse(`${utcDay(epochMs)}T00:00:00Z`) + 86_400_000;
  return Math.max(1, Math.ceil((next - epochMs) / 1000));
}

export const expiryEpoch = (epochMs: number, days: number): number =>
  Math.floor(epochMs / 1000) + days * 86_400;

// ── Retention (classic day-N: a session on exactly day 1/7/30 after first seen) ───────
export type RetentionBucket = "d1" | "d7" | "d30";

export function retentionBucket(daysSinceFirstSeen: number): RetentionBucket | null {
  if (daysSinceFirstSeen === 1) return "d1";
  if (daysSinceFirstSeen === 7) return "d7";
  if (daysSinceFirstSeen === 30) return "d30";
  return null;
}

// ── Config plane ───────────────────────────────────────────────────────────────────────

export const etagFor = (version: number): string => `"v${version}"`;

export function isValidEnv(env: string): env is Env {
  return (ENVS as readonly string[]).includes(env);
}

/** Validate a config document at publish time: a JSON object (not array/scalar), ≤64 KB. */
export function validateConfigDoc(json: string): { ok: true } | { ok: false; error: string } {
  if (Buffer.byteLength(json, "utf8") > MAX_CONFIG_BYTES) {
    return { ok: false, error: `Config exceeds ${MAX_CONFIG_BYTES / 1024} KB.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "Config is not valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "Config must be a JSON object at the top level." };
  }
  return { ok: true };
}

// ── Batch planning (pure): what a valid batch does to the counters ────────────────────

export interface BatchPlan {
  /** Total events in the batch — the increment that doubles as the cap check. */
  totalEvents: number;
  /** Custom-event increments by name (reserved names excluded). */
  customCounts: Map<string, number>;
  sessionStarts: number;
  /** Clamped seconds from each session_end that carried a value. */
  sessionEndSeconds: number[];
}

export const clampSessionSeconds = (v: number): number => Math.min(Math.max(Math.round(v), 0), 86_400);

export function planBatch(events: GameEvent[]): BatchPlan {
  const customCounts = new Map<string, number>();
  let sessionStarts = 0;
  const sessionEndSeconds: number[] = [];
  for (const ev of events) {
    if (ev.n === "session_start") {
      sessionStarts += 1;
    } else if (ev.n === "session_end") {
      if (ev.v !== undefined) sessionEndSeconds.push(clampSessionSeconds(ev.v));
    } else {
      customCounts.set(ev.n, (customCounts.get(ev.n) ?? 0) + 1);
    }
  }
  return { totalEvents: events.length, customCounts, sessionStarts, sessionEndSeconds };
}

/** Cardinality guard: an unseen name only gets its own counter while the day's distinct
 * count is under the cap; past it, traffic lands in event#__other so a griefer cannot
 * explode the table with random names. Approximate under concurrency BY DESIGN — it is a
 * table-shape guard, not billing. */
export function eventSkFor(name: string, isNewName: boolean, distinctNamesToday: number, cardCap: number): string {
  if (!isNewName) return skEvent(name);
  return distinctNamesToday < cardCap ? skEvent(name) : SK_OTHER;
}

export const capExceeded = (newTotal: number, cap: number): boolean => newTotal > cap;
