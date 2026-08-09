import { describe, expect, it, vi } from "vitest";
import { GetItemCommand, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { makeStore, type DynamoLike } from "./store";

const TABLE = "LiveOpsPoppyData";

/** A fake DynamoDB client: routes by command type, records every call. */
function fakeClient(routes: {
  getItem?: (input: any) => any;
  putItem?: (input: any) => any;
  updateItem?: (input: any) => any;
}) {
  const calls: { kind: string; input: any }[] = [];
  const client: DynamoLike = {
    async send(cmd: any) {
      if (cmd instanceof GetItemCommand) {
        calls.push({ kind: "get", input: cmd.input });
        return routes.getItem?.(cmd.input) ?? {};
      }
      if (cmd instanceof PutItemCommand) {
        calls.push({ kind: "put", input: cmd.input });
        return routes.putItem?.(cmd.input) ?? {};
      }
      if (cmd instanceof UpdateItemCommand) {
        calls.push({ kind: "update", input: cmd.input });
        return routes.updateItem?.(cmd.input) ?? {};
      }
      throw new Error(`Unexpected command ${cmd?.constructor?.name}`);
    },
  };
  return { client, calls };
}

const conditionalFailure = () => {
  const e = new Error("conditional");
  (e as any).name = "ConditionalCheckFailedException";
  throw e;
};

const metaItem = {
  Item: {
    pk: { S: "title#abcd1234" },
    sk: { S: "meta" },
    name: { S: "My Game" },
    salt: { S: "salt-1" },
    keyHash: { S: "ab".repeat(32) },
    eventCap: { N: "500000" },
    cardCap: { N: "200" },
  },
};

describe("getTitleMeta", () => {
  it("parses the meta item and caches it for 60 s", async () => {
    let now = 0;
    const { client, calls } = fakeClient({ getItem: () => metaItem });
    const store = makeStore(client, TABLE, () => now);

    const meta = await store.getTitleMeta("abcd1234");
    expect(meta).toMatchObject({ titleId: "abcd1234", name: "My Game", eventCap: 500_000, cardCap: 200 });
    expect(meta?.keyHash2).toBeUndefined();

    await store.getTitleMeta("abcd1234");
    expect(calls.filter((c) => c.kind === "get")).toHaveLength(1); // cached

    now = 61_000;
    await store.getTitleMeta("abcd1234");
    expect(calls.filter((c) => c.kind === "get")).toHaveLength(2); // cache expired
  });

  it("returns (and caches) null for an unknown title", async () => {
    const { client, calls } = fakeClient({ getItem: () => ({}) });
    const store = makeStore(client, TABLE, () => 0);
    expect(await store.getTitleMeta("nope1234")).toBeNull();
    expect(await store.getTitleMeta("nope1234")).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("getCurrentConfig", () => {
  it("serves {v:0, {}} when nothing was ever published", async () => {
    const { client } = fakeClient({ getItem: () => ({}) });
    const store = makeStore(client, TABLE, () => 0);
    expect(await store.getCurrentConfig("abcd1234", "prod")).toEqual({ version: 0, json: "{}" });
  });

  it("follows the pointer to the version document", async () => {
    const { client, calls } = fakeClient({
      getItem: (input) => {
        if (input.Key.sk.S === "current") return { Item: { version: { N: "42" } } };
        if (input.Key.sk.S === "v#000042") return { Item: { json: { S: '{"speed":2}' } } };
        return {};
      },
    });
    const store = makeStore(client, TABLE, () => 0);
    expect(await store.getCurrentConfig("abcd1234", "prod")).toEqual({ version: 42, json: '{"speed":2}' });
    expect(calls[1]!.input.Key.sk.S).toBe("v#000042"); // zero-padded contract

    await store.getCurrentConfig("abcd1234", "prod");
    expect(calls).toHaveLength(2); // cached
  });

  it("serves defaults on a dangling pointer instead of breaking a game boot", async () => {
    const { client } = fakeClient({
      getItem: (input) =>
        input.Key.sk.S === "current" ? { Item: { version: { N: "7" } } } : {},
    });
    const store = makeStore(client, TABLE, () => 0);
    expect(await store.getCurrentConfig("abcd1234", "dev")).toEqual({ version: 0, json: "{}" });
  });
});

describe("counters", () => {
  it("addTotal ADDs to the count attribute and returns the new total", async () => {
    const { client, calls } = fakeClient({
      updateItem: () => ({ Attributes: { count: { N: "12345" } } }),
    });
    const store = makeStore(client, TABLE, () => 0);
    expect(await store.addTotal("abcd1234", "2026-08-09", 25)).toBe(12_345);
    const input = calls[0]!.input;
    expect(input.Key.pk.S).toBe("day#abcd1234#2026-08-09");
    expect(input.Key.sk.S).toBe("total#events");
    expect(input.UpdateExpression).toBe("ADD #c :n");
    expect(input.ExpressionAttributeNames["#c"]).toBe("count");
  });
});

describe("conditional writes", () => {
  it("putUniq: true first time, false when the row exists, rethrows anything else", async () => {
    let mode: "ok" | "dupe" | "boom" = "ok";
    const { client } = fakeClient({
      putItem: () => {
        if (mode === "dupe") conditionalFailure();
        if (mode === "boom") throw new Error("throttled");
        return {};
      },
    });
    const store = makeStore(client, TABLE, () => 0);
    expect(await store.putUniq("t", "2026-08-09", "hash", 123)).toBe(true);
    mode = "dupe";
    expect(await store.putUniq("t", "2026-08-09", "hash", 123)).toBe(false);
    mode = "boom";
    await expect(store.putUniq("t", "2026-08-09", "hash", 123)).rejects.toThrow("throttled");
  });

  it("createPlayer + markRetention share the same conditional semantics", async () => {
    let fail = false;
    const { client, calls } = fakeClient({
      putItem: () => (fail ? conditionalFailure() : {}),
      updateItem: () => (fail ? conditionalFailure() : {}),
    });
    const store = makeStore(client, TABLE, () => 0);
    expect(await store.createPlayer("t", "hash", "2026-08-09", 99)).toBe(true);
    expect(await store.markRetention("t", "hash", "d7")).toBe(true);
    const mark = calls.find((c) => c.kind === "update")!.input;
    expect(mark.ConditionExpression).toBe("attribute_not_exists(#b)");
    expect(mark.ExpressionAttributeNames["#b"]).toBe("d7");
    fail = true;
    expect(await store.createPlayer("t", "hash", "2026-08-09", 99)).toBe(false);
    expect(await store.markRetention("t", "hash", "d7")).toBe(false);
  });
});

describe("resolveEventSk (cardinality guard)", () => {
  it("routes an already-existing counter and remembers it in the container", async () => {
    const { client, calls } = fakeClient({
      getItem: (input) =>
        input.Key.sk.S === "event#level_won" ? { Item: { count: { N: "5" } } } : {},
    });
    const store = makeStore(client, TABLE, () => 0);
    expect(await store.resolveEventSk("t", "2026-08-09", "level_won", 200)).toBe("event#level_won");
    expect(await store.resolveEventSk("t", "2026-08-09", "level_won", 200)).toBe("event#level_won");
    expect(calls.filter((c) => c.kind === "get")).toHaveLength(1); // second hit = container cache
  });

  it("admits a new name under the cap and bumps the distinct-names counter", async () => {
    const { client, calls } = fakeClient({
      getItem: (input) => {
        if (input.Key.sk.S === "card#names") return { Item: { count: { N: "10" } } };
        return {}; // the event counter doesn't exist yet
      },
      updateItem: () => ({ Attributes: { count: { N: "11" } } }),
    });
    const store = makeStore(client, TABLE, () => 0);
    expect(await store.resolveEventSk("t", "2026-08-09", "fresh_event", 200)).toBe("event#fresh_event");
    const bump = calls.find((c) => c.kind === "update")!.input;
    expect(bump.Key.sk.S).toBe("card#names");
  });

  it("routes overflow names into __other without bumping the counter", async () => {
    const { client, calls } = fakeClient({
      getItem: (input) => {
        if (input.Key.sk.S === "card#names") return { Item: { count: { N: "200" } } };
        return {};
      },
    });
    const store = makeStore(client, TABLE, () => 0);
    expect(await store.resolveEventSk("t", "2026-08-09", "griefer_spam_1", 200)).toBe("event#__other");
    expect(calls.filter((c) => c.kind === "update")).toHaveLength(0);
  });
});
