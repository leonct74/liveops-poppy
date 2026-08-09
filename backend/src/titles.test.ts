import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { generateKey, generateTitleId, KEY_GRACE_DAYS, TitleRegistry, titleName, type DynamoLike } from "./titles";
import { DEFAULT_CARD_CAP, DEFAULT_EVENT_CAP, TITLE_ID_RE } from "../../shared/src/keys";

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
      else if (cmd instanceof DeleteItemCommand) calls.push({ kind: "delete", input: cmd.input });
      else throw new Error(`Unexpected command ${cmd?.constructor?.name}`);
      return {};
    },
  };
  return { db, calls };
}

const metaItem = (over: Record<string, any> = {}) => ({
  Item: {
    pk: { S: "title#abcd1234" },
    sk: { S: "meta" },
    name: { S: "My Game" },
    createdAt: { S: "2026-08-01T00:00:00.000Z" },
    salt: { S: "salt-1" },
    keyHash: { S: "ab".repeat(32) },
    eventCap: { N: "500000" },
    cardCap: { N: "200" },
    ...over,
  },
});

describe("generators", () => {
  it("produces title ids the collector's regex accepts", () => {
    for (let i = 0; i < 50; i++) expect(TITLE_ID_RE.test(generateTitleId())).toBe(true);
  });

  it("produces URL-safe keys long enough for the collector's length check", () => {
    const key = generateKey();
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(128);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/); // travels as ?k= on the config GET
  });
});

describe("titleName", () => {
  it("trims, and refuses empty or overlong names", () => {
    expect(titleName("  My Game  ")).toBe("My Game");
    expect(() => titleName("")).toThrow(/needs a name/);
    expect(() => titleName("x".repeat(65))).toThrow(/64 characters/);
  });
});

describe("create", () => {
  it("stores only the key HASH, defaults the caps, and registers the title", async () => {
    const { db, calls } = fake();
    const registry = new TitleRegistry(db, TABLE, () => NOW);
    const { title, key } = await registry.create("My Game");

    const meta = calls.find((c) => c.kind === "put" && c.input.Item.sk.S === "meta")!.input;
    expect(meta.Item.keyHash.S).toBe(createHash("sha256").update(key).digest("hex"));
    expect(JSON.stringify(meta.Item)).not.toContain(key); // plaintext key never persisted
    expect(meta.Item.salt.S).toMatch(/^[0-9a-f]{32}$/);
    expect(meta.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(Number(meta.Item.eventCap.N)).toBe(DEFAULT_EVENT_CAP);
    expect(Number(meta.Item.cardCap.N)).toBe(DEFAULT_CARD_CAP);

    const index = calls.find((c) => c.kind === "put" && c.input.Item.pk.S === "titles")!.input;
    expect(index.Item.sk.S).toBe(`title#${title.titleId}`);
  });
});

describe("list", () => {
  it("queries the registry row (never Scans) and reads live meta", async () => {
    const { db, calls } = fake({
      query: () => ({ Items: [{ sk: { S: "title#abcd1234" } }] }),
      get: () => metaItem(),
    });
    const titles = await new TitleRegistry(db, TABLE, () => NOW).list();
    expect(titles).toHaveLength(1);
    expect(titles[0]).toMatchObject({ titleId: "abcd1234", name: "My Game", eventCap: 500_000 });
    expect(calls.find((c) => c.kind === "query")!.input.ExpressionAttributeValues[":p"].S).toBe("titles");
    expect(calls.some((c) => c.kind === "scan")).toBe(false);
  });
});

describe("get", () => {
  it("rejects a malformed id without touching AWS", async () => {
    const { db, calls } = fake();
    expect(await new TitleRegistry(db, TABLE, () => NOW).get("BAD ID!")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("surfaces a live grace window and hides a lapsed one", async () => {
    const live = new Date(NOW + 86_400_000).toISOString();
    const lapsed = new Date(NOW - 86_400_000).toISOString();
    const withLive = fake({ get: () => metaItem({ keyHash2ValidUntil: { S: live } }) });
    expect((await new TitleRegistry(withLive.db, TABLE, () => NOW).get("abcd1234"))?.previousKeyValidUntil).toBe(live);
    const withLapsed = fake({ get: () => metaItem({ keyHash2ValidUntil: { S: lapsed } }) });
    expect(
      (await new TitleRegistry(withLapsed.db, TABLE, () => NOW).get("abcd1234"))?.previousKeyValidUntil,
    ).toBeUndefined();
  });
});

describe("rotateKey", () => {
  it("keeps the outgoing key alive for the grace window so shipped builds don't break", async () => {
    const { db, calls } = fake({ get: () => metaItem() });
    const { key, previousKeyValidUntil } = await new TitleRegistry(db, TABLE, () => NOW).rotateKey("abcd1234");

    const update = calls.find((c) => c.kind === "update")!.input;
    expect(update.UpdateExpression).toBe(
      "SET keyHash2 = keyHash, keyHash = :new, keyHash2ValidUntil = :until",
    );
    expect(update.ExpressionAttributeValues[":new"].S).toBe(createHash("sha256").update(key).digest("hex"));
    expect(Date.parse(previousKeyValidUntil) - NOW).toBe(KEY_GRACE_DAYS * 86_400_000);
  });

  it("refuses to rotate a title that doesn't exist", async () => {
    const { db } = fake({ get: () => ({}) });
    await expect(new TitleRegistry(db, TABLE, () => NOW).rotateKey("abcd1234")).rejects.toThrow("No such title.");
  });
});

describe("setCaps", () => {
  it("floors both caps at 1 — a zero cap would black-hole a live game's telemetry", async () => {
    const { db, calls } = fake({ get: () => metaItem() });
    const result = await new TitleRegistry(db, TABLE, () => NOW).setCaps("abcd1234", {
      eventCap: 0,
      cardCap: -5,
    });
    expect(result.eventCap).toBe(1);
    expect(result.cardCap).toBe(1);
    const update = calls.find((c) => c.kind === "update")!.input;
    expect(update.ExpressionAttributeValues[":e"].N).toBe("1");
  });

  it("leaves an unspecified cap untouched", async () => {
    const { db } = fake({ get: () => metaItem() });
    const result = await new TitleRegistry(db, TABLE, () => NOW).setCaps("abcd1234", { eventCap: 1000 });
    expect(result.eventCap).toBe(1000);
    expect(result.cardCap).toBe(DEFAULT_CARD_CAP);
  });
});

describe("remove", () => {
  it("deletes the registry entry and the meta row", async () => {
    const { db, calls } = fake();
    await new TitleRegistry(db, TABLE, () => NOW).remove("abcd1234");
    const deletes = calls.filter((c) => c.kind === "delete").map((c) => c.input.Key);
    expect(deletes).toContainEqual({ pk: { S: "titles" }, sk: { S: "title#abcd1234" } });
    expect(deletes).toContainEqual({ pk: { S: "title#abcd1234" }, sk: { S: "meta" } });
  });
});
