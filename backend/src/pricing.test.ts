import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_REQUESTS_PER_MILLION_USD,
  BUILTIN_WRITES_PER_MILLION_USD,
  builtinPrices,
  fetchPriceBook,
  makePriceLoader,
  unitPriceFromPriceList,
  unitPriceUsd,
  type PricingLike,
} from "./pricing";

/** A Price List document, trimmed to the parts we read but otherwise the real shape. */
const doc = (unit: string, usd: string, extra: Record<string, unknown> = {}) => ({
  product: { productFamily: "Amazon DynamoDB PayPerRequest Throughput", sku: "SKU1" },
  terms: {
    OnDemand: {
      "SKU1.JRTCKXETXF": {
        priceDimensions: {
          "SKU1.JRTCKXETXF.6YS6EN2CT7": {
            unit,
            beginRange: "0",
            endRange: "Inf",
            pricePerUnit: { USD: usd },
          },
          ...extra,
        },
      },
    },
  },
});

describe("unitPriceUsd", () => {
  it("reads the per-unit price for the unit it was asked for", () => {
    expect(unitPriceUsd(doc("WriteRequestUnits", "0.0000012500"), "WriteRequestUnits")).toBe(0.00000125);
  });

  it("matches the unit case-insensitively", () => {
    expect(unitPriceUsd(doc("Requests", "0.0000002"), "requests")).toBe(0.0000002);
  });

  it("ignores dimensions priced in something else", () => {
    expect(unitPriceUsd(doc("ReadRequestUnits", "0.00000025"), "WriteRequestUnits")).toBeNull();
  });

  it("skips the free-tier 0.00 dimension and takes the real price", () => {
    const withFreeTier = doc("WriteRequestUnits", "0.0000012500", {
      "SKU1.JRTCKXETXF.FREE": {
        unit: "WriteRequestUnits",
        pricePerUnit: { USD: "0.0000000000" },
      },
    });
    expect(unitPriceUsd(withFreeTier, "WriteRequestUnits")).toBe(0.00000125);
  });

  it("returns null rather than guessing when the shape is not what we expect", () => {
    for (const bad of [null, undefined, {}, { terms: {} }, { terms: { OnDemand: "nope" } }, 42]) {
      expect(unitPriceUsd(bad, "WriteRequestUnits")).toBeNull();
    }
    expect(unitPriceUsd(doc("WriteRequestUnits", "not-a-number"), "WriteRequestUnits")).toBeNull();
  });
});

describe("unitPriceFromPriceList", () => {
  it("parses the JSON strings AWS actually returns", () => {
    const list = [JSON.stringify(doc("WriteRequestUnits", "0.000001"))];
    expect(unitPriceFromPriceList(list, "WriteRequestUnits")).toBe(0.000001);
  });

  it("survives a malformed entry beside a good one", () => {
    const list = ["{not json", JSON.stringify(doc("Requests", "0.0000002")), undefined];
    expect(unitPriceFromPriceList(list, "Requests")).toBe(0.0000002);
  });

  it("is null when nothing matches, so the caller can fall back", () => {
    expect(unitPriceFromPriceList([], "Requests")).toBeNull();
  });
});

/** An AWS that answers correctly on the first filter candidate for both services. */
const okClient = (): PricingLike => ({
  send: vi.fn(async (command: any) => {
    const service = command.input.ServiceCode;
    return {
      PriceList: [
        JSON.stringify(
          service === "AmazonDynamoDB"
            ? doc("WriteRequestUnits", "0.00000125")
            : doc("Requests", "0.0000002"),
        ),
      ],
    };
  }),
});

describe("fetchPriceBook", () => {
  it("converts AWS's per-unit prices to per-million, and says they came from AWS", async () => {
    const book = await fetchPriceBook(okClient(), "eu-west-1");
    expect(book.source).toBe("aws");
    expect(book.region).toBe("eu-west-1");
    expect(book.writesPerMillionUsd).toBeCloseTo(1.25, 6);
    expect(book.requestsPerMillionUsd).toBeCloseTo(0.2, 6);
  });

  it("filters on the region being priced, not the region it asks from", async () => {
    const client = okClient();
    await fetchPriceBook(client, "ap-southeast-2");
    for (const call of (client.send as any).mock.calls) {
      expect(call[0].input.Filters).toContainEqual({
        Type: "TERM_MATCH",
        Field: "regionCode",
        Value: "ap-southeast-2",
      });
    }
  });

  it("falls back to built-in prices when the call fails — a cost estimate must never break the dashboard", async () => {
    const failing: PricingLike = { send: async () => { throw new Error("AccessDenied"); } };
    const book = await fetchPriceBook(failing, "eu-west-1");
    expect(book).toEqual(builtinPrices("eu-west-1"));
    expect(book.writesPerMillionUsd).toBe(BUILTIN_WRITES_PER_MILLION_USD);
    expect(book.requestsPerMillionUsd).toBe(BUILTIN_REQUESTS_PER_MILLION_USD);
  });

  it("tries the next product filter when the first matches nothing", async () => {
    // We cannot verify AWS's exact `group` values from here, so a renamed (or mis-guessed)
    // filter must not silently defeat the lookup — the second candidate has to be tried.
    const send = vi.fn(async (command: any) => {
      const { ServiceCode, Filters } = command.input;
      const byFamily = Filters.some((f: any) => f.Field === "productFamily");
      if (!byFamily) return { PriceList: [] }; // pretend `group` no longer matches
      return {
        PriceList: [
          JSON.stringify(
            ServiceCode === "AmazonDynamoDB"
              ? doc("WriteRequestUnits", "0.00000125")
              : doc("Requests", "0.0000002"),
          ),
        ],
      };
    });
    const book = await fetchPriceBook({ send }, "eu-west-1");
    expect(book.source).toBe("aws");
    expect(book.writesPerMillionUsd).toBeCloseTo(1.25, 6);
  });

  it("does not keep asking once a candidate answers", async () => {
    const client = okClient();
    await fetchPriceBook(client, "eu-west-1");
    expect((client.send as any).mock.calls).toHaveLength(2); // one per service, not per candidate
  });

  it("says in the log why it fell back, so a silent estimate is diagnosable", async () => {
    const lines: string[] = [];
    await fetchPriceBook({ send: async () => { throw new Error("AccessDenied"); } }, "eu-west-1", (m) => lines.push(m));
    expect(lines.join(" ")).toMatch(/AccessDenied.*built-in/i);

    lines.length = 0;
    await fetchPriceBook({ send: async () => ({ PriceList: [] }) }, "eu-west-1", (m) => lines.push(m));
    expect(lines.join(" ")).toMatch(/no match.*eu-west-1.*built-in/i);
  });

  it("falls back rather than mixing one live price with one stale one", async () => {
    // Lambda answers, DynamoDB does not — half an answer is worse than a labelled guess.
    const half: PricingLike = {
      send: async (command: any) =>
        command.input.ServiceCode === "AWSLambda"
          ? { PriceList: [JSON.stringify(doc("Requests", "0.0000002"))] }
          : { PriceList: [] },
    };
    expect((await fetchPriceBook(half, "eu-west-1")).source).toBe("builtin");
  });
});

describe("makePriceLoader", () => {
  it("asks AWS once, however many dashboards ask it", async () => {
    const client = okClient();
    const load = makePriceLoader(client, "eu-west-1");
    await Promise.all([load(), load(), load()]);
    // Two calls for one lookup (DynamoDB + Lambda), not six.
    expect((client.send as any).mock.calls).toHaveLength(2);
  });
});
