import { describe, expect, it } from "vitest";
import { normalizeEndpoint, restSnippets, unitySdkSource } from "./sdkSource";

const OPTS = { endpoint: "https://abc123.lambda-url.eu-west-1.on.aws/", titleId: "abcd1234" };

describe("normalizeEndpoint", () => {
  it("strips trailing slashes so paths never double up", () => {
    expect(normalizeEndpoint("https://x.aws/")).toBe("https://x.aws");
    expect(normalizeEndpoint("https://x.aws///")).toBe("https://x.aws");
    expect(normalizeEndpoint("https://x.aws")).toBe("https://x.aws");
  });
});

describe("unitySdkSource", () => {
  const src = unitySdkSource(OPTS);

  it("bakes in the endpoint and title id, with no double slash in either route", () => {
    expect(src).toContain('const string Endpoint = "https://abc123.lambda-url.eu-west-1.on.aws"');
    expect(src).toContain('const string TitleId  = "abcd1234"');
    expect(src).not.toContain(".on.aws/\"");
  });

  it("never embeds a real key — only a placeholder the developer replaces", () => {
    expect(src).toContain("PASTE_YOUR_TITLE_KEY_HERE");
  });

  it("emits valid C# string escapes, not raw JS ones (the generator's easiest mistake)", () => {
    // The payload builder must produce C# `\"` escapes inside its string literals.
    expect(src).toContain('sb.Append("{\\"t\\":")');
    // And no stray JS template artefacts.
    expect(src).not.toContain("${");
  });

  it("has the whole offline story: cache, fallback defaults, persisted queue", () => {
    expect(src).toContain("liveops-config.json");
    expect(src).toContain("liveops-queue.json");
    expect(src).toContain("LoadCachedConfig");
    // Every getter takes a default the game falls back to.
    expect(src).toContain("GetFloat(string path, float fallback = 0f)");
    expect(src).toContain("GetBool(string path, bool fallback = false)");
  });

  it("stops sending when the backend says the daily cap is reached", () => {
    expect(src).toContain("responseCode == 429");
  });

  it("re-queues on transient failures but drops permanently-rejected batches", () => {
    expect(src).toContain("_queue.InsertRange(0, batch)");
    expect(src).toContain("responseCode >= 400 && req.responseCode < 500");
  });

  it("uses a random install id, never a device or advertising identifier", () => {
    expect(src).toContain("Guid.NewGuid().ToString()");
    expect(src).not.toMatch(/deviceUniqueIdentifier|advertisingId|IDFA/i);
  });

  it("batches at the size the collector accepts", () => {
    expect(src).toContain("const int    MaxBatch = 25;");
  });
});

describe("restSnippets", () => {
  const rest = restSnippets(OPTS);

  it("documents both endpoints with the real address", () => {
    expect(rest.config).toContain("/config/abcd1234/prod?k=");
    expect(rest.events).toContain('"t": "abcd1234"');
    expect(rest.events).toContain("/e");
  });

  it("mentions the 304 revalidation and the 429 cap — the two behaviours that surprise people", () => {
    expect(rest.config).toContain("If-None-Match");
    expect(rest.events).toContain("429");
  });
});
