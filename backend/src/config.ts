// The remote-config plane: versioned publish + one-click rollback.
//
// Every publish writes an IMMUTABLE version item (v#000042) and then flips a pointer
// (sk = "current"). Rollback flips the pointer back — it never rewrites history, so the
// developer can always see what was live and return to it. That immutability is also what
// makes the collector's ETag safe: "v42" always means the same bytes.

import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  CONFIG_HISTORY_LIMIT,
  cfgPk,
  cfgVersionSk,
  isValidEnv,
  SK_CURRENT,
  type Env,
} from "../../shared/src/keys";
import { validateConfigDoc } from "../../lambdas/src/core";
import type { DynamoLike } from "./titles";

export interface ConfigVersion {
  version: number;
  publishedAt: string;
  note: string;
  /** Absent in history listings (they'd be huge); present on a single fetch. */
  json?: string;
}

export interface CurrentConfigView {
  env: Env;
  version: number;
  json: string;
  publishedAt?: string;
  note?: string;
}

const s = (v: string): AttributeValue => ({ S: v });
const n = (v: number): AttributeValue => ({ N: String(v) });

export function parseEnv(raw: unknown): Env {
  const env = typeof raw === "string" ? raw : "";
  if (!isValidEnv(env)) throw new Error("Environment must be 'dev' or 'prod'.");
  return env;
}

export class ConfigStore {
  constructor(
    private readonly db: DynamoLike,
    private readonly tableName: string,
    private readonly nowMs: () => number = Date.now,
  ) {}

  private async item(pk: string, sk: string): Promise<Record<string, AttributeValue> | null> {
    const out = await this.db.send(
      new GetItemCommand({ TableName: this.tableName, Key: { pk: s(pk), sk: s(sk) } }),
    );
    return (out.Item as Record<string, AttributeValue> | undefined) ?? null;
  }

  /** The live document for an env. A never-published env reads as version 0 + `{}` —
   * the same thing the collector serves, so the editor shows exactly what games receive. */
  async current(titleId: string, env: Env): Promise<CurrentConfigView> {
    const pk = cfgPk(titleId, env);
    const pointer = await this.item(pk, SK_CURRENT);
    const version = pointer?.version?.N ? Number(pointer.version.N) : 0;
    if (version <= 0) return { env, version: 0, json: "{}" };
    const doc = await this.item(pk, cfgVersionSk(version));
    if (!doc?.json?.S) return { env, version: 0, json: "{}" };
    return {
      env,
      version,
      json: doc.json.S,
      ...(doc.publishedAt?.S ? { publishedAt: doc.publishedAt.S } : {}),
      ...(doc.note?.S ? { note: doc.note.S } : {}),
    };
  }

  /** Recent versions, newest first — the rollback list. */
  async history(titleId: string, env: Env, limit = CONFIG_HISTORY_LIMIT): Promise<ConfigVersion[]> {
    const out = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :p AND begins_with(sk, :v)",
        ExpressionAttributeValues: { ":p": s(cfgPk(titleId, env)), ":v": s("v#") },
        // Zero-padded version keys make lexicographic order = numeric order, so "newest
        // first" is just a reverse scan (shared/keys.ts::cfgVersionSk).
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (out.Items ?? []).map((it: Record<string, AttributeValue>) => ({
      version: Number((it.sk?.S ?? "v#0").slice(2)),
      publishedAt: it.publishedAt?.S ?? "",
      note: it.note?.S ?? "",
    }));
  }

  /**
   * Publish a new version. Validates the document FIRST (a broken config would reach every
   * running game), writes it immutably, then flips the pointer.
   */
  async publish(titleId: string, env: Env, json: string, note = ""): Promise<CurrentConfigView> {
    const valid = validateConfigDoc(json);
    if (!valid.ok) throw new Error(valid.error);

    const pk = cfgPk(titleId, env);
    const pointer = await this.item(pk, SK_CURRENT);
    const nextVersion = (pointer?.version?.N ? Number(pointer.version.N) : 0) + 1;
    const publishedAt = new Date(this.nowMs()).toISOString();

    await this.db.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: {
          pk: s(pk),
          sk: s(cfgVersionSk(nextVersion)),
          json: s(json),
          publishedAt: s(publishedAt),
          note: s(note.slice(0, 200)),
        },
        // Versions are immutable: refuse to overwrite one if two publishes race.
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    await this.db.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { pk: s(pk), sk: s(SK_CURRENT) },
        UpdateExpression: "SET version = :v",
        ExpressionAttributeValues: { ":v": n(nextVersion) },
      }),
    );
    return { env, version: nextVersion, json, publishedAt, note };
  }

  /** Point an env back at an earlier version. Refuses a version that isn't there, so a
   * mistyped number can't blank a live game's config. */
  async rollback(titleId: string, env: Env, version: number): Promise<CurrentConfigView> {
    if (!Number.isInteger(version) || version < 1) throw new Error("Version must be a positive whole number.");
    const pk = cfgPk(titleId, env);
    const doc = await this.item(pk, cfgVersionSk(version));
    if (!doc?.json?.S) throw new Error(`Version ${version} doesn't exist for this title.`);
    await this.db.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { pk: s(pk), sk: s(SK_CURRENT) },
        UpdateExpression: "SET version = :v",
        ExpressionAttributeValues: { ":v": n(version) },
      }),
    );
    return {
      env,
      version,
      json: doc.json.S,
      ...(doc.publishedAt?.S ? { publishedAt: doc.publishedAt.S } : {}),
      ...(doc.note?.S ? { note: doc.note.S } : {}),
    };
  }
}
