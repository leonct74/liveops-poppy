import { describe, expect, it } from "vitest";
import { DeleteItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { PlayerEraser } from "./players";
import { playerHash } from "../../lambdas/src/core";
import { UNIQ_TTL_DAYS } from "../../shared/src/keys";
import type { DynamoLike } from "./titles";

const TABLE = "LiveOpsPoppyData";
const NOW = Date.parse("2026-08-09T12:00:00Z");
const SALT = "salt-1";

function fake(routes: { get?: (i: any) => any } = {}) {
  const calls: { kind: string; input: any }[] = [];
  const db: DynamoLike = {
    async send(cmd: any) {
      if (cmd instanceof GetItemCommand) {
        calls.push({ kind: "get", input: cmd.input });
        return routes.get?.(cmd.input) ?? {};
      }
      if (cmd instanceof DeleteItemCommand) {
        calls.push({ kind: "delete", input: cmd.input });
        return {};
      }
      throw new Error(`Unexpected command ${cmd?.constructor?.name}`);
    },
  };
  return { db, calls };
}

const metaWithSalt = { Item: { salt: { S: SALT } } };

describe("erase", () => {
  it("hashes the install id exactly as the collector does, then deletes the player row", async () => {
    const { db, calls } = fake({
      get: (i) => (i.Key.sk.S === "meta" ? metaWithSalt : { Item: { firstSeen: { S: "2026-08-01" } } }),
    });
    const result = await new PlayerEraser(db, TABLE, () => NOW).erase("abcd1234", "install-id-0001");

    const expected = playerHash(SALT, "install-id-0001");
    expect(result.playerHash).toBe(expected);
    expect(result.playerRowDeleted).toBe(true);
    const deletes = calls.filter((c) => c.kind === "delete").map((c) => c.input.Key);
    expect(deletes).toContainEqual({ pk: { S: "player#abcd1234" }, sk: { S: expected } });
  });

  it("clears the daily-unique rows across the whole TTL window — a bounded sweep", async () => {
    const { db, calls } = fake({ get: (i) => (i.Key.sk.S === "meta" ? metaWithSalt : {}) });
    const result = await new PlayerEraser(db, TABLE, () => NOW).erase("abcd1234", "install-id-0001");

    expect(result.uniqueDaysCleared).toBe(UNIQ_TTL_DAYS);
    const uniqDeletes = calls.filter((c) => c.kind === "delete" && c.input.Key.pk.S.startsWith("uniq#"));
    expect(uniqDeletes).toHaveLength(UNIQ_TTL_DAYS);
    expect(uniqDeletes.map((c) => c.input.Key.pk.S)).toContain("uniq#abcd1234#2026-08-09");
  });

  it("reports honestly that aggregate counters are left intact", async () => {
    const { db, calls } = fake({ get: (i) => (i.Key.sk.S === "meta" ? metaWithSalt : {}) });
    const result = await new PlayerEraser(db, TABLE, () => NOW).erase("abcd1234", "install-id-0001");
    expect(result.note).toMatch(/not player-identifiable/);
    // Nothing under a day# partition may be touched by an erasure.
    expect(calls.some((c) => c.kind === "delete" && c.input.Key.pk.S.startsWith("day#"))).toBe(false);
  });

  it("refuses an empty install id and an unknown title", async () => {
    const { db } = fake({ get: () => ({}) });
    const eraser = new PlayerEraser(db, TABLE, () => NOW);
    await expect(eraser.erase("abcd1234", "   ")).rejects.toThrow(/install id is required/);
    await expect(eraser.erase("abcd1234", "install-id-0001")).rejects.toThrow("No such title.");
  });

  it("reports playerRowDeleted=false when the player was already gone (idempotent)", async () => {
    const { db } = fake({ get: (i) => (i.Key.sk.S === "meta" ? metaWithSalt : {}) });
    const result = await new PlayerEraser(db, TABLE, () => NOW).erase("abcd1234", "install-id-0001");
    expect(result.playerRowDeleted).toBe(false);
  });
});
