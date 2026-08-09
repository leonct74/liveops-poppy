import { describe, expect, it } from "vitest";
import { QueryCommand } from "@aws-sdk/client-dynamodb";
import { ASSUMED_BATCH_SIZE, ASSUMED_WRITES_PER_EVENT, estimateCost, StatsReader } from "./stats";
import type { DynamoLike } from "./titles";

const TABLE = "LiveOpsPoppyData";
const NOW = Date.parse("2026-08-09T12:00:00Z");

const counter = (sk: string, count: number) => ({ sk: { S: sk }, count: { N: String(count) } });

function fake(byPk: Record<string, any[]>) {
  const queried: string[] = [];
  const db: DynamoLike = {
    async send(cmd: any) {
      if (!(cmd instanceof QueryCommand)) throw new Error("Only Query expected");
      const pk = String((cmd.input as any).ExpressionAttributeValues[":p"].S);
      queried.push(pk);
      return { Items: byPk[pk] ?? [] };
    },
  };
  return { db, queried };
}

describe("estimateCost", () => {
  it("is honest about being an estimate, never a bill or a cap", () => {
    const est = estimateCost(1_000_000);
    expect(est.basis).toMatch(/estimate, not your bill/i);
    expect(est.basis).not.toMatch(/cap|limit/i);
  });

  it("prices from the documented assumptions", () => {
    const events = 1_000_000;
    const expected =
      (events * ASSUMED_WRITES_PER_EVENT) / 1_000_000 * 1.25 +
      Math.ceil(events / ASSUMED_BATCH_SIZE) / 1_000_000 * 0.2;
    expect(estimateCost(events).estimatedUsd).toBe(Math.round(expected * 100) / 100);
  });

  it("costs nothing at zero traffic (the idle promise)", () => {
    expect(estimateCost(0).estimatedUsd).toBe(0);
  });
});

describe("overview", () => {
  const days = 3;
  const today = "2026-08-09";
  const yesterday = "2026-08-08";

  it("aggregates counters, ranks breakdowns, and keeps DAU per-day", async () => {
    const { db, queried } = fake({
      [`day#abcd1234#${yesterday}`]: [
        counter("dau", 40),
        counter("total#events", 100),
        counter("sess#count", 10),
        counter("sess#seconds", 1000),
        counter("plat#ios", 6),
        counter("event#level_won", 30),
      ],
      [`day#abcd1234#${today}`]: [
        counter("dau", 50),
        counter("total#events", 200),
        counter("sess#count", 20),
        counter("sess#seconds", 5000),
        counter("plat#ios", 12),
        counter("plat#android", 8),
        counter("ver#1.2.0", 20),
        counter("event#level_won", 60),
        counter("event#shop_open", 15),
        counter("card#names", 2), // bookkeeping — must not appear as a metric
      ],
    });
    const overview = await new StatsReader(db, TABLE, () => NOW).overview("abcd1234", days);

    expect(queried).toHaveLength(days);
    // DAU is a per-day measure: the headline shows TODAY's, never a meaningless sum.
    expect(overview.totals.dau).toBe(50);
    expect(overview.totals.events).toBe(300);
    expect(overview.totals.sessions).toBe(30);
    expect(overview.totals.avgSessionSeconds).toBe(200); // 6000s / 30 sessions
    expect(overview.platforms).toEqual([
      { name: "ios", count: 18 },
      { name: "android", count: 8 },
    ]);
    expect(overview.events[0]).toEqual({ name: "level_won", count: 90 });
    expect(overview.events.some((e) => e.name === "names")).toBe(false);
    expect(overview.eventOverflow).toBe(false);
    expect(overview.cost.events).toBe(300);
  });

  it("flags the cardinality overflow bucket so the studio can raise the cap", async () => {
    const { db } = fake({ [`day#abcd1234#${today}`]: [counter("event#__other", 5)] });
    const overview = await new StatsReader(db, TABLE, () => NOW).overview("abcd1234", 1);
    expect(overview.eventOverflow).toBe(true);
  });

  it("returns a zeroed row for a day with no traffic (no gaps in the chart)", async () => {
    const { db } = fake({});
    const overview = await new StatsReader(db, TABLE, () => NOW).overview("abcd1234", 3);
    expect(overview.days).toHaveLength(3);
    expect(overview.days.every((d) => d.dau === 0 && d.events === 0)).toBe(true);
    expect(overview.totals.avgSessionSeconds).toBe(0); // no divide-by-zero
  });
});

describe("retention", () => {
  it("reads cohort counters and drops empty cohorts", async () => {
    const { db } = fake({
      "cohort#abcd1234#2026-08-08": [counter("size", 100), counter("d1", 40)],
      "cohort#abcd1234#2026-08-09": [counter("size", 50)],
    });
    const cohorts = await new StatsReader(db, TABLE, () => NOW).retention("abcd1234", 3);
    expect(cohorts).toHaveLength(2);
    expect(cohorts[0]).toEqual({ cohortDay: "2026-08-08", size: 100, d1: 40, d7: 0, d30: 0 });
  });
});
