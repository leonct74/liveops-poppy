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

  it("takes the permissions boundary only as a well-formed managed-policy ARN", () => {
    // Anything else is "the host did not confirm one", which the deploy must read as
    // preserve-what's-deployed — never as an instruction to strip a boundary. And a junk
    // value must NOT pass through: it would turn the stack's HasPermissionsBoundary
    // condition on and make IAM refuse every CreateRole in it (a rolled-back deploy in
    // place of the graceful unbounded one).
    const arn = "arn:aws:iam::123456789012:policy/AgentsPoppyBoundary";
    process.env.AGENTSPOPPY_BOOTSTRAP = JSON.stringify({ ...BOOT, permissionsBoundaryArn: arn });
    expect(readBootstrap().permissionsBoundaryArn).toBe(arn);
    // Surrounding whitespace is a transport artefact, not a different ARN.
    process.env.AGENTSPOPPY_BOOTSTRAP = JSON.stringify({ ...BOOT, permissionsBoundaryArn: `  ${arn}\n` });
    expect(readBootstrap().permissionsBoundaryArn).toBe(arn);
    // Other partitions are real ARNs too.
    const gov = "arn:aws-us-gov:iam::123456789012:policy/AgentsPoppyBoundary";
    process.env.AGENTSPOPPY_BOOTSTRAP = JSON.stringify({ ...BOOT, permissionsBoundaryArn: gov });
    expect(readBootstrap().permissionsBoundaryArn).toBe(gov);
    for (const bad of [
      "",
      "   ",
      "\t\n",
      null,
      7,
      { arn },
      "AgentsPoppyBoundary",
      "arn:aws:iam::123456789012:policy/", // no policy name
      "arn:aws:iam::12345:policy/AgentsPoppyBoundary", // not a 12-digit account
      "arn:aws:iam::123456789012:role/AgentsPoppyBoundary", // a role, not a policy
      "not-an-arn-at-all",
    ]) {
      process.env.AGENTSPOPPY_BOOTSTRAP = JSON.stringify({ ...BOOT, permissionsBoundaryArn: bad });
      expect(readBootstrap().permissionsBoundaryArn).toBeUndefined();
    }
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
