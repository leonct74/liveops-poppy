import { afterEach, describe, expect, it, vi } from "vitest";
import { brokerCredentialsProvider, readBootstrap, type BackendBootstrap } from "./boot";

const BOOT: BackendBootstrap = {
  connectionId: "conn-1",
  credentialsUrl: "http://127.0.0.1:9/mint",
  credentialsToken: "tok",
  account: { accountId: "123456789012", region: "eu-west-1" },
};

const CREDS = {
  accessKeyId: "AKIA...",
  secretAccessKey: "secret",
  sessionToken: "session",
  expiration: new Date(Date.now() + 3_600_000).toISOString(),
};

const jsonResponse = (status: number, body: unknown): Response =>
  ({ ok: status < 300, status, json: async () => body }) as unknown as Response;

describe("readBootstrap", () => {
  afterEach(() => {
    delete process.env.AGENTSPOPPY_BOOTSTRAP;
  });

  it("refuses to run outside AgentsPoppy", () => {
    delete process.env.AGENTSPOPPY_BOOTSTRAP;
    expect(() => readBootstrap()).toThrow(/spawned by AgentsPoppy/);
  });

  it("rejects junk and incomplete payloads", () => {
    process.env.AGENTSPOPPY_BOOTSTRAP = "{not json";
    expect(() => readBootstrap()).toThrow(/not valid JSON/);
    process.env.AGENTSPOPPY_BOOTSTRAP = JSON.stringify({ connectionId: "x" });
    expect(() => readBootstrap()).toThrow(/missing required fields/);
  });

  it("parses a complete bootstrap", () => {
    process.env.AGENTSPOPPY_BOOTSTRAP = JSON.stringify(BOOT);
    expect(readBootstrap()).toEqual(BOOT);
  });
});

describe("brokerCredentialsProvider", () => {
  it("mints once and caches until near expiry", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, CREDS));
    const provider = brokerCredentialsProvider(BOOT, { fetchImpl });
    const first = await provider();
    const second = await provider();
    expect(first.accessKeyId).toBe(CREDS.accessKeyId);
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const headers = (fetchImpl.mock.calls[0] as any)[1].headers;
    expect(headers.authorization).toBe("Bearer tok");
  });

  it("polls a supervised 202 approval envelope until credentials arrive", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(202, { approvalRequired: true, approval: { id: "ap-1" } }))
      .mockResolvedValueOnce(jsonResponse(200, CREDS));
    const sleep = vi.fn(async () => {});
    const provider = brokerCredentialsProvider(BOOT, { fetchImpl, sleep });
    const creds = await provider();
    expect(creds.sessionToken).toBe(CREDS.sessionToken);
    // The poll echoes the approval id back.
    expect(JSON.parse((fetchImpl.mock.calls[1] as any)[1].body)).toEqual({ approvalId: "ap-1" });
  });

  it("surfaces the broker's own message on refusal", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { message: "Connection is paused." }));
    const provider = brokerCredentialsProvider(BOOT, { fetchImpl });
    await expect(provider()).rejects.toThrow("Connection is paused.");
  });

  it("wraps transport failures in a calm waiting message, never a raw fetch error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    const provider = brokerCredentialsProvider(BOOT, { fetchImpl });
    await expect(provider()).rejects.toThrow(/waiting for AWS access/);
  });
});
