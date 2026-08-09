// "Delete this player" — the GDPR/COPPA support path (DESIGN.md §6).
//
// This is cheap ONLY because the data model was built for it: aggregate counters hold no
// player identifiers, so erasing a player means deleting their pseudonymous rows and
// nothing else. Counters stay correct and untouched; that is the whole reason the design
// is aggregates-first rather than raw-events-first.
//
// The developer supplies the player's INSTALL ID (their game's support flow can surface
// it). We hash it with the title's salt exactly as the collector does, then delete:
//   - the player row (first/last seen + retention flags)
//   - that player's daily-unique rows within the TTL window (older ones have expired)

import { DeleteItemCommand, GetItemCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";
import { lastDays, playerPk, SK_META, titlePk, UNIQ_TTL_DAYS, uniqPk } from "../../shared/src/keys";
import { playerHash } from "../../lambdas/src/core";
import type { DynamoLike } from "./titles";

export interface ErasureResult {
  /** The pseudonym we erased — shown so the developer can record what was done. */
  playerHash: string;
  playerRowDeleted: boolean;
  uniqueDaysCleared: number;
  note: string;
}

const s = (v: string): AttributeValue => ({ S: v });

export class PlayerEraser {
  constructor(
    private readonly db: DynamoLike,
    private readonly tableName: string,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async erase(titleId: string, installId: string): Promise<ErasureResult> {
    const id = installId.trim();
    if (!id) throw new Error("An install id is required.");

    const metaOut = await this.db.send(
      new GetItemCommand({ TableName: this.tableName, Key: { pk: s(titlePk(titleId)), sk: s(SK_META) } }),
    );
    const salt = (metaOut.Item as Record<string, AttributeValue> | undefined)?.salt?.S;
    if (!salt) throw new Error("No such title.");

    const hash = playerHash(salt, id);

    const before = await this.db.send(
      new GetItemCommand({ TableName: this.tableName, Key: { pk: s(playerPk(titleId)), sk: s(hash) } }),
    );
    const playerRowDeleted = !!before.Item;
    if (playerRowDeleted) {
      await this.db.send(
        new DeleteItemCommand({ TableName: this.tableName, Key: { pk: s(playerPk(titleId)), sk: s(hash) } }),
      );
    }

    // Daily-unique rows: bounded by the TTL window, so this is a fixed ~40 deletes, never
    // an unbounded sweep. Deleting a row that isn't there is a no-op, so no read first.
    const days = lastDays(UNIQ_TTL_DAYS, this.nowMs());
    await Promise.all(
      days.map((day) =>
        this.db.send(
          new DeleteItemCommand({
            TableName: this.tableName,
            Key: { pk: s(uniqPk(titleId, day)), sk: s(hash) },
          }),
        ),
      ),
    );

    return {
      playerHash: hash,
      playerRowDeleted,
      uniqueDaysCleared: days.length,
      note:
        "Aggregate counters (daily active players, sessions, event counts) are not player-identifiable " +
        "and are intentionally left intact — erasing them would corrupt the studio's own historical totals.",
    };
  }
}
