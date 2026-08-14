// THE SCHEMA CONTRACT — shared by the collector Lambda and the admin backend so the two
// planes can never drift on a key shape.
//
// ⚠️ These literals are PUBLIC: studios point their own BI tools at the table
// (DESIGN.md §1.3), so changing one is a breaking schema change, not a refactor.
// lambdas/src/core.test.ts locks every one of them.

export const ENVS = ["dev", "prod"] as const;
export type Env = (typeof ENVS)[number];

export function isValidEnv(env: string): env is Env {
  return (ENVS as readonly string[]).includes(env);
}

// ── Limits (DESIGN.md §5 — the bill-protection knobs) ─────────────────────────────────
export const MAX_BATCH = 25;
export const MAX_BODY_BYTES = 32 * 1024;
export const EVENT_NAME_RE = /^[a-z0-9_]{1,64}$/;
export const TITLE_ID_RE = /^[a-z0-9]{4,32}$/;
export const MAX_CONFIG_BYTES = 64 * 1024;
export const DEFAULT_EVENT_CAP = 500_000; // events/day/title — enforced, real-time
export const DEFAULT_CARD_CAP = 200; // distinct custom event names/day/title — approximate
export const UNIQ_TTL_DAYS = 40; // DAU hash rows age out
export const PLAYER_TTL_DAYS = 396; // ~13 months of inactivity → the player row expires
export const CONFIG_MAX_AGE_S = 60; // client + in-Lambda cache horizon for config reads
export const CONFIG_HISTORY_LIMIT = 20; // versions the editor lists

/** Event names the SDK owns; they drive sessions/retention and never become custom counters. */
export const RESERVED_EVENTS = new Set(["session_start", "session_end"]);

// ── Key literals ───────────────────────────────────────────────────────────────────────
export const SK_META = "meta";
export const SK_CURRENT = "current";
export const SK_TOTAL = "total#events";
export const SK_OTHER = "event#__other";
export const SK_CARD = "card#names";
export const SK_SESS_COUNT = "sess#count";
export const SK_SESS_SECONDS = "sess#seconds";
export const SK_DAU = "dau";
export const SK_COHORT_SIZE = "size";

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

/** The registry row listing every title (so the admin plane never Scans the table). */
export const TITLES_INDEX_PK = "titles";

/**
 * 🪤 The DynamoDB attribute every counter's value lives in. ONE definition, imported by the
 * writer (store.ts `ADD #c :n`) and by BOTH readers (backend/stats.ts and the viewer
 * Lambda) — because the viewer once read `item.n` while the store wrote `count`: every
 * query succeeded, every row came back, and every number parsed as 0. The team dashboard
 * shipped showing zeros for a game with data, its unit tests green because the fixtures
 * seeded the same wrong attribute the reader expected (founder, 2026-08-14). A name that
 * exists in one place cannot drift.
 */
export const COUNTER_ATTR = "count";

// ── Time ───────────────────────────────────────────────────────────────────────────────

/** UTC day bucket. Callers pass the time explicitly — never let a data-affecting value
 * default to `new Date()` at a distance (MailPoppy's importer idempotency rule). */
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

/** The last N UTC days ending today, oldest first — the dashboard's x-axis. */
export function lastDays(n: number, epochMs: number): string[] {
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i--) days.push(utcDay(epochMs - i * 86_400_000));
  return days;
}
