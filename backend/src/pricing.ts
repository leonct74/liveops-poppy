// What AWS actually charges — asked, not assumed.
//
// The dashboard tells a studio what their telemetry is costing. A hardcoded price is a
// promise with an expiry date on it: AWS changes prices, prices differ by region, and a
// number that was right in August is quietly wrong by Christmas with nothing to signal it.
// So we ask the Price List API (a free, read-only call, inside the studio's own account)
// and fall back to built-in figures only when we cannot — clearly labelled as approximate,
// never presented as a quote.
//
// Everything below the client call is pure, so the parsing is tested against real Price
// List shapes without touching AWS.

import { GetProductsCommand, type PricingClient } from "@aws-sdk/client-pricing";

export interface PriceBook {
  /** USD per million DynamoDB on-demand write request units. */
  writesPerMillionUsd: number;
  /** USD per million Lambda invocations. */
  requestsPerMillionUsd: number;
  /** Where these came from. The UI must not show a guess as if it were a quote. */
  source: "aws" | "builtin";
  /** The region the prices apply to. */
  region: string;
}

// Public AWS on-demand list prices (us-east-1, Aug 2026) — the floor we fall back to when
// the Price List API is unreachable. Deliberately the only hardcoded prices in the repo.
export const BUILTIN_WRITES_PER_MILLION_USD = 1.25;
export const BUILTIN_REQUESTS_PER_MILLION_USD = 0.2;

export const builtinPrices = (region: string): PriceBook => ({
  writesPerMillionUsd: BUILTIN_WRITES_PER_MILLION_USD,
  requestsPerMillionUsd: BUILTIN_REQUESTS_PER_MILLION_USD,
  source: "builtin",
  region,
});

/**
 * The Price List query API only answers in a few regions, wherever the *priced* region is.
 * Filters carry the region we actually care about; this is just where we ask.
 */
export const PRICING_API_REGION = "us-east-1";

/**
 * Pull the USD unit price out of one Price List document.
 *
 * The shape is `terms.OnDemand.<offer>.priceDimensions.<dim>.pricePerUnit.USD`, with the
 * dimension's `unit` naming what is being priced. We select by `unit` rather than by SKU or
 * attribute names, because units ("WriteRequestUnits", "Requests") are the part of this
 * schema that stays put; everything else AWS reserves the right to rename.
 *
 * Free tiers appear as a 0.00 dimension alongside the real one, so the *lowest non-zero*
 * price is what a studio past the free tier actually pays.
 */
export function unitPriceUsd(document: unknown, unit: string): number | null {
  const onDemand = (document as { terms?: { OnDemand?: Record<string, unknown> } })?.terms?.OnDemand;
  if (!onDemand || typeof onDemand !== "object") return null;

  let best: number | null = null;
  for (const offer of Object.values(onDemand)) {
    const dims = (offer as { priceDimensions?: Record<string, unknown> })?.priceDimensions;
    if (!dims || typeof dims !== "object") continue;
    for (const dim of Object.values(dims)) {
      const d = dim as { unit?: unknown; pricePerUnit?: { USD?: unknown } };
      if (typeof d?.unit !== "string" || d.unit.toLowerCase() !== unit.toLowerCase()) continue;
      const usd = Number(d.pricePerUnit?.USD);
      if (!Number.isFinite(usd) || usd <= 0) continue;
      if (best === null || usd < best) best = usd;
    }
  }
  return best;
}

/** The same, across a whole `PriceList` response (each entry is a JSON *string*). */
export function unitPriceFromPriceList(priceList: (string | undefined)[], unit: string): number | null {
  let best: number | null = null;
  for (const entry of priceList) {
    if (typeof entry !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry);
    } catch {
      continue; // one malformed document must not cost us the whole lookup
    }
    const usd = unitPriceUsd(parsed, unit);
    if (usd !== null && (best === null || usd < best)) best = usd;
  }
  return best;
}

/** The subset of PricingClient we use — so tests need no AWS and no mocking library. */
export interface PricingLike {
  send(command: GetProductsCommand): Promise<{ PriceList?: (string | undefined)[] }>;
}

/**
 * Filters that narrow a service to the product we want, tried in order.
 *
 * AWS reserves the right to rename an attribute value, and `group`/`productFamily` are
 * exactly the sort of thing that gets renamed — whereas the price dimension's `unit` is
 * load-bearing for AWS's own billing and does not move. So each candidate is only a way to
 * get a small enough page to search; the *selection* is always by unit. If the first
 * candidate matches nothing we try the next, and only then give up.
 */
export const PRODUCT_FILTERS: Record<string, { field: string; value: string }[]> = {
  AmazonDynamoDB: [
    { field: "group", value: "DDB-WriteUnits" },
    { field: "productFamily", value: "Amazon DynamoDB PayPerRequest Throughput" },
  ],
  AWSLambda: [
    { field: "group", value: "AWS-Lambda-Requests" },
    { field: "productFamily", value: "Serverless" },
  ],
};

async function priceFor(
  pricing: PricingLike,
  serviceCode: string,
  region: string,
  unit: string,
): Promise<number | null> {
  for (const candidate of PRODUCT_FILTERS[serviceCode] ?? []) {
    const out = await pricing.send(
      new GetProductsCommand({
        ServiceCode: serviceCode,
        Filters: [
          { Type: "TERM_MATCH", Field: "regionCode", Value: region },
          { Type: "TERM_MATCH", Field: candidate.field, Value: candidate.value },
        ],
        MaxResults: 100,
      }),
    );
    const usd = unitPriceFromPriceList(out.PriceList ?? [], unit);
    if (usd !== null) return usd;
  }
  return null;
}

/**
 * Fetch both prices for a region. Never throws: a pricing outage, a missing permission or a
 * renamed filter degrades to the built-in numbers, because a dashboard that fails to load
 * over a cost *estimate* would be a worse product than one showing an approximate figure.
 */
export async function fetchPriceBook(
  pricing: PricingLike,
  region: string,
  log: (message: string) => void = () => {},
): Promise<PriceBook> {
  try {
    const [writeUnit, request] = await Promise.all([
      priceFor(pricing, "AmazonDynamoDB", region, "WriteRequestUnits"),
      priceFor(pricing, "AWSLambda", region, "Requests"),
    ]);
    // Partial answers are not good enough to label "aws": mixing a live price with a stale
    // one produces a number nobody can reason about.
    if (writeUnit === null || request === null) {
      log(
        `price list returned no match for ${writeUnit === null ? "DynamoDB write units" : ""}` +
          `${writeUnit === null && request === null ? " and " : ""}` +
          `${request === null ? "Lambda requests" : ""} in ${region} — using built-in prices`,
      );
      return builtinPrices(region);
    }
    return {
      writesPerMillionUsd: writeUnit * 1_000_000,
      requestsPerMillionUsd: request * 1_000_000,
      source: "aws",
      region,
    };
  } catch (e) {
    log(`price list unavailable (${(e as Error).message}) — using built-in prices`);
    return builtinPrices(region);
  }
}

/**
 * A price loader that asks AWS once per process and remembers the answer. Prices move on a
 * scale of months and the poppy's backend restarts far more often than that, so one call
 * per launch is both fresh enough and the least we can ask for.
 */
export function makePriceLoader(
  pricing: PricingLike,
  region: string,
  log: (message: string) => void = (m) => console.log(`[liveopspoppy] ${m}`),
): () => Promise<PriceBook> {
  let pending: Promise<PriceBook> | null = null;
  return () => {
    if (!pending) pending = fetchPriceBook(pricing, region, log);
    return pending;
  };
}

export type { PricingClient };
