import { describe, expect, it } from "vitest";
import { normalizeEndpoint, restSnippets, unitySdkSource } from "./sdkSource";

const OPTS = { endpoint: "https://abc123.lambda-url.eu-west-1.on.aws/", titleId: "abcd1234" };

// ── A C# lexer, deliberately small ────────────────────────────────────────────────────
// The SDK is C# emitted from a JavaScript template literal, so every backslash in it is
// escaped twice and no compiler in this repo will ever look at the result. That is exactly
// the shape of bug that ships silently: `"{\"t\":"` and `"{\\"t\\":"` are both perfectly
// valid JavaScript and only one of them is valid C#. This walks the generated text the way
// a compiler's first pass would — comments, string and char literals, then brackets — and
// catches an escaping or brace mistake at `npm test` instead of in someone's Unity console.
//
// It is a lexical check, not a compile. `docs/UNITY.md` covers what only Unity can prove.
interface Scan {
  curly: number;
  paren: number;
  square: number;
  /** Lowest brace depth reached — negative means a `}` arrived before its `{`. */
  minCurly: number;
  badEscapes: string[];
  unterminated: string[];
}

/** C# simple-escape characters, plus the three numeric-escape introducers. */
const CSHARP_ESCAPES = new Set(["'", '"', "\\", "0", "a", "b", "f", "n", "r", "t", "v", "u", "x", "U"]);

export function scanCSharp(src: string): Scan {
  const scan: Scan = { curly: 0, paren: 0, square: 0, minCurly: 0, badEscapes: [], unterminated: [] };
  const lineOf = (idx: number) => src.slice(0, idx).split("\n").length;
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }

    if (c === '"' || c === "'") {
      const startLine = lineOf(i);
      let closed = false;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          const esc = src[i + 1] ?? "";
          if (!CSHARP_ESCAPES.has(esc)) scan.badEscapes.push(`line ${lineOf(i)}: \\${esc}`);
          i += 2;
          continue;
        }
        if (src[i] === c) {
          closed = true;
          i++;
          break;
        }
        if (src[i] === "\n") break; // a non-verbatim C# literal cannot span lines
        i++;
      }
      if (!closed) scan.unterminated.push(`line ${startLine}: ${c}`);
      continue;
    }

    if (c === "{") scan.curly++;
    else if (c === "}") scan.minCurly = Math.min(scan.minCurly, --scan.curly);
    else if (c === "(") scan.paren++;
    else if (c === ")") scan.paren--;
    else if (c === "[") scan.square++;
    else if (c === "]") scan.square--;
    i++;
  }
  return scan;
}

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

  it("never suspends a coroutine while holding the queue lock", () => {
    // `yield` inside `lock` compiles to a Monitor held across a suspension point. Take the
    // batch, release, then yield — so the lock body must contain no yield at all.
    const blocks = [...src.matchAll(/lock \(_queue\)\s*\{([\s\S]*?)\n {8}\}/g)];
    expect(blocks.length).toBeGreaterThanOrEqual(3); // Enqueue, Flush, SaveQueue
    for (const body of blocks) expect(body[1]).not.toContain("yield");
  });

  it("exposes the API the docs promise, and nothing calls into a package", () => {
    for (const member of [
      "public static void Init()",
      "public static string GetString(",
      "public static float GetFloat(",
      "public static int GetInt(",
      "public static bool GetBool(",
      "public static void Track(string name)",
      "public static void Track(string name, double value)",
    ]) {
      expect(src).toContain(member);
    }
    // The whole pitch is "one file, no dependencies": only Unity's own namespaces allowed.
    const usings = [...src.matchAll(/^using ([\w.]+);$/gm)].map((m) => m[1] ?? "");
    expect(usings).not.toHaveLength(0);
    for (const ns of usings) {
      expect(ns === "UnityEngine" || ns === "UnityEngine.Networking" || ns.startsWith("System")).toBe(true);
    }
  });

  it("lexes as C#: balanced brackets, well-formed literals, valid escapes", () => {
    const scan = scanCSharp(src);
    expect(scan.badEscapes).toEqual([]);
    expect(scan.unterminated).toEqual([]);
    expect(scan.curly).toBe(0);
    expect(scan.paren).toBe(0);
    expect(scan.square).toBe(0);
    expect(scan.minCurly).toBe(0); // a `}` never precedes its `{`
  });

  it("the lexer would actually catch the mistakes it is there for", () => {
    // Guard against the check silently passing everything.
    expect(scanCSharp('var s = "\\q";').badEscapes).toHaveLength(1);
    expect(scanCSharp('var s = "unclosed;').unterminated).toHaveLength(1);
    expect(scanCSharp("void F() { if (x) { }").curly).toBe(1);
    expect(scanCSharp("void F() { } }").minCurly).toBe(-1);
    // ...and that it does not trip over the things that are fine.
    expect(scanCSharp("// a } stray brace and \"quote in a comment\n{}").curly).toBe(0);
    expect(scanCSharp("var c = '\\\\'; var d = '}';").curly).toBe(0);
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
