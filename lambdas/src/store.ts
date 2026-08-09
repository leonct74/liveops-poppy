// The collector's thin DynamoDB layer. Every DECISION lives in core.ts; this file only
// moves items. The client is injected so tests run against a fake — no AWS in CI.
//
// Uses the raw DynamoDB client (AttributeValue maps), not the DocumentClient: the raw
// client can't trip the undefined-marshalling trap that bit MailPoppy's Lambdas.

import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  cfgPk,
  cfgVersionSk,
  cohortPk,
  dayPk,
  eventSkFor,
  playerPk,
  SK_CARD,
  SK_CURRENT,
  SK_META,
  SK_TOTAL,
  titlePk,
  uniqPk,
  type Env,
  type RetentionBucket,
  type TitleMeta,
} from "./core";

/** Structural client type — the real DynamoDBClient or a test fake. */
export interface DynamoLike {
  send(command: unknown): Promise<any>;
}

const CACHE_TTL_MS = 60_000;

interface Cached<T> {
  value: T;
  at: number;
}

export interface CurrentConfig {
  version: number;
  /** The raw JSON string of the current config document ("{}" when never published). */
  json: string;
}

export interface PlayerRow {
  firstSeen: string;
}

export interface Store {
  getTitleMeta(titleId: string): Promise<TitleMeta | null>;
  getCurrentConfig(titleId: string, env: Env): Promise<CurrentConfig>;
  /** ADD n to the day's received-events counter; returns the NEW total (the cap meter). */
  addTotal(titleId: string, day: string, n: number): Promise<number>;
  /** ADD n to a plain counter item under the day partition (or any pk/sk pair). */
  addCounter(pk: string, sk: string, n: number): Promise<void>;
  /** Conditional-put a DAU hash row; true when this player is new for the day. */
  putUniq(titleId: string, day: string, hash: string, expiresAt: number): Promise<boolean>;
  getPlayer(titleId: string, hash: string): Promise<PlayerRow | null>;
  /** Conditional-create the player row; false when another invocation won the race. */
  createPlayer(titleId: string, hash: string, day: string, expiresAt: number): Promise<boolean>;
  touchPlayer(titleId: string, hash: string, day: string, expiresAt: number): Promise<void>;
  /** SET the d1/d7/d30 flag once; true exactly the first time (drives cohort counters). */
  markRetention(titleId: string, hash: string, bucket: RetentionBucket): Promise<boolean>;
  /** Resolve which counter a custom event lands in, enforcing the cardinality cap. */
  resolveEventSk(titleId: string, day: string, name: string, cardCap: number): Promise<string>;
}

const s = (v: string): AttributeValue => ({ S: v });
const n = (v: number): AttributeValue => ({ N: String(v) });
const readN = (a: AttributeValue | undefined, fallback: number): number =>
  a?.N !== undefined ? Number(a.N) : fallback;

const isConditionalFailure = (e: unknown): boolean =>
  (e as { name?: string })?.name === "ConditionalCheckFailedException";

export function makeStore(client: DynamoLike, tableName: string, nowMs: () => number = Date.now): Store {
  const metaCache = new Map<string, Cached<TitleMeta | null>>();
  const configCache = new Map<string, Cached<CurrentConfig>>();
  /** Per-container memory of (titleId#day) → names known to have a counter already. */
  const seenNames = new Map<string, Set<string>>();
  const cardCache = new Map<string, Cached<number>>();

  const fresh = <T>(c: Cached<T> | undefined): c is Cached<T> => !!c && nowMs() - c.at < CACHE_TTL_MS;

  async function getItem(pk: string, sk: string): Promise<Record<string, AttributeValue> | null> {
    const out = await client.send(
      new GetItemCommand({ TableName: tableName, Key: { pk: s(pk), sk: s(sk) } }),
    );
    return out.Item ?? null;
  }

  async function add(pk: string, sk: string, by: number): Promise<number> {
    const out = await client.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: s(pk), sk: s(sk) },
        UpdateExpression: "ADD #c :n",
        ExpressionAttributeNames: { "#c": "count" },
        ExpressionAttributeValues: { ":n": n(by) },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return readN(out.Attributes?.count, 0);
  }

  return {
    async getTitleMeta(titleId) {
      const hit = metaCache.get(titleId);
      if (fresh(hit)) return hit.value;
      const item = await getItem(titlePk(titleId), SK_META);
      const meta: TitleMeta | null = item
        ? {
            titleId,
            name: item.name?.S ?? "",
            salt: item.salt?.S ?? "",
            keyHash: item.keyHash?.S ?? "",
            ...(item.keyHash2?.S ? { keyHash2: item.keyHash2.S } : {}),
            eventCap: readN(item.eventCap, 0),
            cardCap: readN(item.cardCap, 0),
          }
        : null;
      metaCache.set(titleId, { value: meta, at: nowMs() });
      return meta;
    },

    async getCurrentConfig(titleId, env) {
      const cacheKey = cfgPk(titleId, env);
      const hit = configCache.get(cacheKey);
      if (fresh(hit)) return hit.value;
      const pointer = await getItem(cacheKey, SK_CURRENT);
      const version = readN(pointer?.version, 0);
      let value: CurrentConfig = { version: 0, json: "{}" };
      if (version > 0) {
        const doc = await getItem(cacheKey, cfgVersionSk(version));
        // A dangling pointer must serve defaults, not break a game boot (DESIGN.md §4).
        value = doc?.json?.S ? { version, json: doc.json.S } : { version: 0, json: "{}" };
      }
      configCache.set(cacheKey, { value, at: nowMs() });
      return value;
    },

    addTotal: (titleId, day, by) => add(dayPk(titleId, day), SK_TOTAL, by),

    async addCounter(pk, sk, by) {
      await add(pk, sk, by);
    },

    async putUniq(titleId, day, hash, expiresAt) {
      try {
        await client.send(
          new PutItemCommand({
            TableName: tableName,
            Item: { pk: s(uniqPk(titleId, day)), sk: s(hash), expiresAt: n(expiresAt) },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
        return true;
      } catch (e) {
        if (isConditionalFailure(e)) return false;
        throw e;
      }
    },

    async getPlayer(titleId, hash) {
      const item = await getItem(playerPk(titleId), hash);
      return item?.firstSeen?.S ? { firstSeen: item.firstSeen.S } : null;
    },

    async createPlayer(titleId, hash, day, expiresAt) {
      try {
        await client.send(
          new PutItemCommand({
            TableName: tableName,
            Item: {
              pk: s(playerPk(titleId)),
              sk: s(hash),
              firstSeen: s(day),
              lastSeen: s(day),
              expiresAt: n(expiresAt),
            },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
        return true;
      } catch (e) {
        if (isConditionalFailure(e)) return false;
        throw e;
      }
    },

    async touchPlayer(titleId, hash, day, expiresAt) {
      await client.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { pk: s(playerPk(titleId)), sk: s(hash) },
          UpdateExpression: "SET lastSeen = :d, expiresAt = :t",
          ExpressionAttributeValues: { ":d": s(day), ":t": n(expiresAt) },
        }),
      );
    },

    async markRetention(titleId, hash, bucket) {
      try {
        await client.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: { pk: s(playerPk(titleId)), sk: s(hash) },
            UpdateExpression: "SET #b = :one",
            ConditionExpression: "attribute_not_exists(#b)",
            ExpressionAttributeNames: { "#b": bucket },
            ExpressionAttributeValues: { ":one": n(1) },
          }),
        );
        return true;
      } catch (e) {
        if (isConditionalFailure(e)) return false;
        throw e;
      }
    },

    async resolveEventSk(titleId, day, name, cardCap) {
      const scope = `${titleId}#${day}`;
      let seen = seenNames.get(scope);
      if (!seen) {
        seen = new Set();
        seenNames.set(scope, seen);
      }
      if (seen.has(name)) return eventSkFor(name, false, 0, cardCap);

      // Unknown to this container — one read tells us if the counter exists already.
      const existing = await getItem(dayPk(titleId, day), `event#${name}`);
      if (existing) {
        seen.add(name);
        return eventSkFor(name, false, 0, cardCap);
      }

      const cardKey = scope;
      const hit = cardCache.get(cardKey);
      let cardCount: number;
      if (fresh(hit)) {
        cardCount = hit.value;
      } else {
        const cardItem = await getItem(dayPk(titleId, day), SK_CARD);
        cardCount = readN(cardItem?.count, 0);
      }
      const sk = eventSkFor(name, true, cardCount, cardCap);
      if (sk !== "event#__other") {
        seen.add(name);
        cardCount = await add(dayPk(titleId, day), SK_CARD, 1);
      }
      cardCache.set(cardKey, { value: cardCount, at: nowMs() });
      return sk;
    },
  };
}
