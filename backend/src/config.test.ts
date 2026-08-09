import { describe, expect, it } from "vitest";
import { GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { ConfigStore, parseEnv } from "./config";
import type { DynamoLike } from "./titles";

const TABLE = "LiveOpsPoppyData";
const NOW = Date.parse("2026-08-09T12:00:00Z");

function fake(routes: { get?: (i: any) => any; query?: (i: any) => any } = {}) {
  const calls: { kind: string; input: any }[] = [];
  const db: DynamoLike = {
    async send(cmd: any) {
      if (cmd instanceof GetItemCommand) {
        calls.push({ kind: "get", input: cmd.input });
        return routes.get?.(cmd.input) ?? {};
      }
      if (cmd instanceof QueryCommand) {
        calls.push({ kind: "query", input: cmd.input });
        return routes.query?.(cmd.input) ?? {};
      }
      if (cmd instanceof PutItemCommand) calls.push({ kind: "put", input: cmd.input });
      else if (cmd instanceof UpdateItemCommand) calls.push({ kind: "update", input: cmd.input });
      else throw new Error(`Unexpected command ${cmd?.constructor?.name}`);
      return {};
    },
  };
  return { db, calls };
}

describe("parseEnv", () => {
  it("accepts dev/prod and refuses anything else", () => {
    expect(parseEnv("dev")).toBe("dev");
    expect(parseEnv("prod")).toBe("prod");
    expect(() => parseEnv("staging")).toThrow(/'dev' or 'prod'/);
    expect(() => parseEnv(undefined)).toThrow();
  });
});

describe("current", () => {
  it("reads version 0 + {} when nothing was ever published", async () => {
    const { db } = fake({ get: () => ({}) });
    expect(await new ConfigStore(db, TABLE, () => NOW).current("abcd1234", "prod")).toEqual({
      env: "prod",
      version: 0,
      json: "{}",
    });
  });

  it("follows the pointer to the immutable version document", async () => {
    const { db } = fake({
      get: (i) =>
        i.Key.sk.S === "current"
          ? { Item: { version: { N: "42" } } }
          : { Item: { json: { S: '{"speed":2}' }, publishedAt: { S: "2026-08-08T00:00:00Z" }, note: { S: "buff" } } },
    });
    expect(await new ConfigStore(db, TABLE, () => NOW).current("abcd1234", "prod")).toEqual({
      env: "prod",
      version: 42,
      json: '{"speed":2}',
      publishedAt: "2026-08-08T00:00:00Z",
      note: "buff",
    });
  });
});

describe("publish", () => {
  it("validates BEFORE writing — a broken document never reaches a running game", async () => {
    const { db, calls } = fake({ get: () => ({}) });
    const store = new ConfigStore(db, TABLE, () => NOW);
    await expect(store.publish("abcd1234", "prod", "not json")).rejects.toThrow(/not valid JSON/);
    await expect(store.publish("abcd1234", "prod", "[1,2]")).rejects.toThrow(/JSON object/);
    expect(calls.filter((c) => c.kind === "put")).toHaveLength(0);
  });

  it("writes v+1 immutably, then flips the pointer", async () => {
    const { db, calls } = fake({
      get: (i) => (i.Key.sk.S === "current" ? { Item: { version: { N: "7" } } } : {}),
    });
    const result = await new ConfigStore(db, TABLE, () => NOW).publish(
      "abcd1234",
      "prod",
      '{"speed":3}',
      "nerf the shotgun",
    );
    expect(result.version).toBe(8);

    const put = calls.find((c) => c.kind === "put")!.input;
    expect(put.Item.sk.S).toBe("v#000008");
    expect(put.ConditionExpression).toBe("attribute_not_exists(pk)"); // versions never overwritten
    expect(put.Item.note.S).toBe("nerf the shotgun");

    const flip = calls.find((c) => c.kind === "update")!.input;
    expect(flip.Key.sk.S).toBe("current");
    expect(flip.ExpressionAttributeValues[":v"].N).toBe("8");
    // Order matters: the document must exist before the pointer names it.
    expect(calls.findIndex((c) => c.kind === "put")).toBeLessThan(calls.findIndex((c) => c.kind === "update"));
  });

  it("starts at version 1 on a fresh env and truncates an overlong note", async () => {
    const { db, calls } = fake({ get: () => ({}) });
    const result = await new ConfigStore(db, TABLE, () => NOW).publish("abcd1234", "dev", "{}", "x".repeat(500));
    expect(result.version).toBe(1);
    expect(calls.find((c) => c.kind === "put")!.input.Item.note.S).toHaveLength(200);
  });
});

describe("history", () => {
  it("lists newest-first and omits the documents themselves", async () => {
    const { db, calls } = fake({
      query: () => ({
        Items: [
          { sk: { S: "v#000009" }, publishedAt: { S: "2026-08-09T00:00:00Z" }, note: { S: "b" }, json: { S: "{}" } },
          { sk: { S: "v#000008" }, publishedAt: { S: "2026-08-08T00:00:00Z" }, note: { S: "a" }, json: { S: "{}" } },
        ],
      }),
    });
    const versions = await new ConfigStore(db, TABLE, () => NOW).history("abcd1234", "prod");
    expect(versions.map((v) => v.version)).toEqual([9, 8]);
    expect(versions[0]).not.toHaveProperty("json");
    expect(calls[0]!.input.ScanIndexForward).toBe(false);
  });
});

describe("rollback", () => {
  it("refuses a version that doesn't exist — a typo can't blank a live config", async () => {
    const { db, calls } = fake({ get: () => ({}) });
    await expect(new ConfigStore(db, TABLE, () => NOW).rollback("abcd1234", "prod", 3)).rejects.toThrow(
      /Version 3 doesn't exist/,
    );
    expect(calls.filter((c) => c.kind === "update")).toHaveLength(0);
  });

  it("refuses a non-positive version", async () => {
    const { db } = fake();
    await expect(new ConfigStore(db, TABLE, () => NOW).rollback("abcd1234", "prod", 0)).rejects.toThrow(
      /positive whole number/,
    );
  });

  it("flips the pointer back WITHOUT rewriting history", async () => {
    const { db, calls } = fake({ get: () => ({ Item: { json: { S: '{"speed":1}' } } }) });
    const result = await new ConfigStore(db, TABLE, () => NOW).rollback("abcd1234", "prod", 5);
    expect(result).toMatchObject({ version: 5, json: '{"speed":1}' });
    expect(calls.filter((c) => c.kind === "put")).toHaveLength(0); // no new version written
    expect(calls.find((c) => c.kind === "update")!.input.ExpressionAttributeValues[":v"].N).toBe("5");
  });
});
