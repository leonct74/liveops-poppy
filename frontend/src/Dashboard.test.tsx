import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { averageRetention, Dashboard, formatDuration } from "./Dashboard";
import { demoApi } from "./demo";
import type { Api } from "./api";
import type { Overview, PriceBook, RetentionPoint } from "./types";

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

// ── The cost card ─────────────────────────────────────────────────────────────────────
const AWS_PRICES: PriceBook = {
  writesPerMillionUsd: 1.25,
  requestsPerMillionUsd: 0.2,
  source: "aws",
  region: "eu-west-1",
};

const overview = (events: number, prices: PriceBook, estimatedUsd = 4.2): Overview => ({
  days: [],
  totals: { dau: 0, sessions: 0, events, avgSessionSeconds: 0 },
  platforms: [],
  versions: [],
  events: [],
  eventOverflow: false,
  cost: { events, estimatedUsd, basis: "It is an estimate, not your bill.", prices },
});

const apiWithCost = (data: Overview): Api => ({
  ...demoApi(),
  stats: vi.fn(async () => data),
  retention: vi.fn(async () => ({ cohorts: [] })),
});

describe("the cost card", () => {
  it("celebrates $0 rather than printing ~$0.00 when nothing has arrived", async () => {
    render(<Dashboard api={apiWithCost(overview(0, AWS_PRICES, 0))} titleId="abcd1234" />);
    await waitFor(() => expect(screen.getByText("$0")).toBeTruthy());
    expect(screen.getByText(/nothing is being billed/i)).toBeTruthy();
    // "~$0.00" reads like a rounding artefact; costing nothing at idle is the whole point.
    expect(screen.queryByText(/~\$0\.00/)).toBeNull();
  });

  it("shows the estimate once traffic exists, with no fallback warning on live prices", async () => {
    render(<Dashboard api={apiWithCost(overview(120_000, AWS_PRICES))} titleId="abcd1234" />);
    await waitFor(() => expect(screen.getByText("~$4.20")).toBeTruthy());
    expect(screen.queryByText(/price list/i)).toBeNull();
  });

  it("says so when the numbers are our fallback, not AWS's", async () => {
    const stale: PriceBook = { ...AWS_PRICES, source: "builtin" };
    render(<Dashboard api={apiWithCost(overview(120_000, stale))} titleId="abcd1234" />);
    await waitFor(() => expect(screen.getByText(/price list/i)).toBeTruthy());
  });

  it("does not report a failed lookup in demo mode, where nothing was ever looked up", async () => {
    const demo: PriceBook = { ...AWS_PRICES, source: "demo" };
    render(<Dashboard api={apiWithCost(overview(120_000, demo))} titleId="abcd1234" />);
    await waitFor(() => expect(screen.getByText("~$4.20")).toBeTruthy());
    expect(screen.queryByText(/price list/i)).toBeNull();
  });
});
