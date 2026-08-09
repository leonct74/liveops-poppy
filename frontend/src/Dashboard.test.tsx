import { describe, expect, it } from "vitest";
import { averageRetention, formatDuration } from "./Dashboard";
import type { RetentionPoint } from "./types";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

describe("averageRetention", () => {
  it("weights by cohort size rather than averaging percentages", () => {
    const cohorts: RetentionPoint[] = [
      { cohortDay: daysAgo(10), size: 900, d1: 90, d7: 0, d30: 0 },
      { cohortDay: daysAgo(9), size: 100, d1: 50, d7: 0, d30: 0 },
    ];
    // Weighted: 140/1000 = 14%. A naive mean of 10% and 50% would say 30%.
    expect(averageRetention(cohorts).d1).toBe(14);
  });

  it("reports null — not 0% — for a milestone no cohort has reached yet", () => {
    const young: RetentionPoint[] = [{ cohortDay: daysAgo(2), size: 100, d1: 40, d7: 0, d30: 0 }];
    const r = averageRetention(young);
    expect(r.d1).toBe(40);
    expect(r.d7).toBeNull(); // showing "0% day-7" on a 2-day-old game would be a lie
    expect(r.d30).toBeNull();
  });

  it("returns nulls with no cohorts at all", () => {
    expect(averageRetention([])).toEqual({ d1: null, d7: null, d30: null });
  });

  it("ignores empty cohorts instead of dividing by zero", () => {
    const cohorts: RetentionPoint[] = [{ cohortDay: daysAgo(10), size: 0, d1: 0, d7: 0, d30: 0 }];
    expect(averageRetention(cohorts).d1).toBeNull();
  });
});

describe("formatDuration", () => {
  it("renders minutes and seconds, and a dash for nothing", () => {
    expect(formatDuration(0)).toBe("—");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(605)).toBe("10m 5s");
  });
});
