// Dashboard reads: daily counters → the numbers a studio actually looks at.
//
// One Query per day partition (they run in parallel), no Scans, no aggregation jobs — the
// collector already did the maths on the write path. Everything below is derived from
// counter rows that hold no player identifiers.

import { QueryCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import {
  COUNTER_ATTR,
  cohortPk,
  dayPk,
  lastDays,
  SK_CARD,
  SK_COHORT_SIZE,
  SK_DAU,
  SK_SESS_COUNT,
  SK_SESS_SECONDS,
  SK_TOTAL,
} from "../../shared/src/keys";
import { builtinPrices, type PriceBook } from "./pricing";
import type { DynamoLike } from "./titles";

export interface DayStats {
  day: string;
  dau: number;
  sessions: number;
  sessionSeconds: number;
  events: number;
}

export interface Breakdown {
  name: string;
  count: number;
}

export interface RetentionPoint {
  cohortDay: string;
  size: number;
  d1: number;
  d7: number;
  d30: number;
}

export interface Overview {
  days: DayStats[];
  totals: { dau: number; sessions: number; events: number; avgSessionSeconds: number };
  platforms: Breakdown[];
  versions: Breakdown[];
  events: Breakdown[];
  /** True when the cardinality guard sent some names to the __other bucket. */
  eventOverflow: boolean;
  cost: CostEstimate;
}

const num = (a: AttributeValue | undefined): number => (a?.N !== undefined ? Number(a.N) : 0);

// ── Cost estimate ─────────────────────────────────────────────────────────────────────
// The unit prices come from AWS itself (pricing.ts). What stays here is the *model*: how
// many writes and requests a given number of events implies.
/** Assumed events per HTTP request — the SDK batches up to MAX_BATCH; real traffic sits
 * lower because flushes fire on a timer too. Deliberately conservative (more requests). */
export const ASSUMED_BATCH_SIZE = 10;
/** Counter writes per event: one shared total + roughly one per counter family touched. */
export const ASSUMED_WRITES_PER_EVENT = 2;

export interface CostEstimate {
  events: number;
  estimatedUsd: number;
  /** Plain-English caveat shown next to the number — never presented as a bill or a cap. */
  basis: string;
  /** Provenance, so the UI can say whether these are live prices or our fallback. */
  prices: PriceBook;
}

/** Pure: what the counters we already hold imply about spend, at the given prices. */
export function estimateCost(eventsThisMonth: number, prices: PriceBook): CostEstimate {
  const writes = eventsThisMonth * ASSUMED_WRITES_PER_EVENT;
  const requests = Math.ceil(eventsThisMonth / ASSUMED_BATCH_SIZE);
  const usd =
    (writes / 1_000_000) * prices.writesPerMillionUsd +
    (requests / 1_000_000) * prices.requestsPerMillionUsd;
  return {
    events: eventsThisMonth,
    estimatedUsd: Math.round(usd * 100) / 100,
    basis:
      `Estimated from the events this deployment actually recorded, at ` +
      (prices.source === "aws"
        ? `AWS's current on-demand prices for ${prices.region}. `
        : `built-in approximate prices — AWS's price list was unreachable, so these may be out of date. `) +
      "It is an estimate, not your bill — AWS is the only authority on what you owe.",
    prices,
  };
}

export class StatsReader {
  constructor(
    private readonly db: DynamoLike,
    private readonly tableName: string,
    private readonly nowMs: () => number = Date.now,
    /** Injected so the dashboard's prices are AWS's, and tests need no network. */
    private readonly loadPrices: () => Promise<PriceBook> = async () => builtinPrices("unknown"),
  ) {}

  private async partition(pk: string): Promise<Record<string, AttributeValue>[]> {
    const out = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :p",
        ExpressionAttributeValues: { ":p": { S: pk } },
      }),
    );
    return (out.Items ?? []) as Record<string, AttributeValue>[];
  }

  async overview(titleId: string, days = 30): Promise<Overview> {
    const dayList = lastDays(days, this.nowMs());
    const [partitions, prices] = await Promise.all([
      Promise.all(dayList.map((d) => this.partition(dayPk(titleId, d)))),
      this.loadPrices(),
    ]);

    const platforms = new Map<string, number>();
    const versions = new Map<string, number>();
    const events = new Map<string, number>();
    let eventOverflow = false;

    const dayStats: DayStats[] = dayList.map((day, i) => {
      const items = partitions[i] ?? [];
      let dau = 0;
      let sessions = 0;
      let sessionSeconds = 0;
      let total = 0;
      for (const item of items) {
        const sk = item.sk?.S ?? "";
        const count = num(item[COUNTER_ATTR]);
        if (sk === SK_DAU) dau = count;
        else if (sk === SK_SESS_COUNT) sessions = count;
        else if (sk === SK_SESS_SECONDS) sessionSeconds = count;
        else if (sk === SK_TOTAL) total = count;
        else if (sk === SK_CARD) continue; // bookkeeping, not a metric
        else if (sk.startsWith("plat#")) platforms.set(sk.slice(5), (platforms.get(sk.slice(5)) ?? 0) + count);
        else if (sk.startsWith("ver#")) versions.set(sk.slice(4), (versions.get(sk.slice(4)) ?? 0) + count);
        else if (sk.startsWith("event#")) {
          const name = sk.slice(6);
          if (name === "__other") eventOverflow = true;
          events.set(name, (events.get(name) ?? 0) + count);
        }
      }
      return { day, dau, sessions, sessionSeconds, events: total };
    });

    const sum = (pick: (d: DayStats) => number) => dayStats.reduce((acc, d) => acc + pick(d), 0);
    const totalSessions = sum((d) => d.sessions);
    const totalSeconds = sum((d) => d.sessionSeconds);

    return {
      days: dayStats,
      totals: {
        // DAU is a per-day measure; summing it would be meaningless, so "dau" here is the
        // most recent day's value — what the headline tile shows.
        dau: dayStats[dayStats.length - 1]?.dau ?? 0,
        sessions: totalSessions,
        events: sum((d) => d.events),
        avgSessionSeconds: totalSessions > 0 ? Math.round(totalSeconds / totalSessions) : 0,
      },
      platforms: rank(platforms),
      versions: rank(versions),
      events: rank(events),
      eventOverflow,
      cost: estimateCost(sum((d) => d.events), prices),
    };
  }

  /** Cohort retention: for each first-seen day, how many came back on day 1 / 7 / 30. */
  async retention(titleId: string, days = 30): Promise<RetentionPoint[]> {
    const cohortDays = lastDays(days, this.nowMs());
    const partitions = await Promise.all(cohortDays.map((d) => this.partition(cohortPk(titleId, d))));
    return cohortDays
      .map((cohortDay, i) => {
        const items = partitions[i] ?? [];
        const value = (sk: string) => num(items.find((it) => it.sk?.S === sk)?.count);
        return {
          cohortDay,
          size: value(SK_COHORT_SIZE),
          d1: value("d1"),
          d7: value("d7"),
          d30: value("d30"),
        };
      })
      .filter((p) => p.size > 0);
  }
}

function rank(map: Map<string, number>): Breakdown[] {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
