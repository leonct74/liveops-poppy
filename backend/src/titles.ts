// Titles: the studio's games. One title = one id + one key + one pseudonymisation salt.
//
// The title KEY is shown to the developer exactly once (it goes into their game build);
// we store only its sha256. Rotation keeps the old hash alive for a grace window so a
// shipped build keeps working while the new key rolls out — the collector honours both
// (core.ts::keyMatches).
//
// The DynamoDB client is injected so every path here is unit-testable without AWS.

import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { createHash, randomBytes } from "node:crypto";
import {
  DEFAULT_CARD_CAP,
  DEFAULT_EVENT_CAP,
  SK_META,
  TITLE_ID_RE,
  TITLES_INDEX_PK,
  titlePk,
} from "../../shared/src/keys";

export interface DynamoLike {
  send(command: unknown): Promise<any>;
}

export interface TitleSummary {
  titleId: string;
  name: string;
  createdAt: string;
  eventCap: number;
  cardCap: number;
  /** Present while a rotated key still has a grace window. */
  previousKeyValidUntil?: string;
}

export interface CreatedTitle {
  title: TitleSummary;
  /** The ONLY time the plaintext key exists outside the game build. */
  key: string;
}

/** Days a rotated-out key keeps working, so shipped builds don't break mid-rollout. */
export const KEY_GRACE_DAYS = 7;

const s = (v: string): AttributeValue => ({ S: v });
const n = (v: number): AttributeValue => ({ N: String(v) });
const readN = (a: AttributeValue | undefined, fallback: number): number =>
  a?.N !== undefined ? Number(a.N) : fallback;

/** 8 chars of [a-z0-9] — meaningless by design (no studio or game name leaks into it). */
export function generateTitleId(bytes: Buffer = randomBytes(8)): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(bytes)
    .map((b) => alphabet[b % alphabet.length])
    .join("");
}

/** 32 URL-safe chars — it travels as ?k= on the config GET. */
export function generateKey(bytes: Buffer = randomBytes(24)): string {
  return bytes.toString("base64url");
}

/** Same hash the collector compares against (core.ts::keyMatches). */
const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");

export function titleName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new Error("A title needs a name.");
  if (name.length > 64) throw new Error("Title names are limited to 64 characters.");
  return name;
}

export class TitleRegistry {
  constructor(
    private readonly db: DynamoLike,
    private readonly tableName: string,
    private readonly nowMs: () => number = Date.now,
  ) {}

  /** Create a title. Returns the plaintext key ONCE — it is never retrievable again. */
  async create(rawName: string): Promise<CreatedTitle> {
    const name = titleName(rawName);
    const titleId = generateTitleId();
    const key = generateKey();
    const createdAt = new Date(this.nowMs()).toISOString();
    const title: TitleSummary = {
      titleId,
      name,
      createdAt,
      eventCap: DEFAULT_EVENT_CAP,
      cardCap: DEFAULT_CARD_CAP,
    };

    await this.db.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: {
          pk: s(titlePk(titleId)),
          sk: s(SK_META),
          name: s(name),
          createdAt: s(createdAt),
          // The per-title STABLE salt: player pseudonymisation depends on it, so it is
          // generated once and never rotated (rotating it would orphan every player row
          // and silently reset retention).
          salt: s(randomBytes(16).toString("hex")),
          keyHash: s(sha256Hex(key)),
          eventCap: n(DEFAULT_EVENT_CAP),
          cardCap: n(DEFAULT_CARD_CAP),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    // The registry row — so listing titles is a Query, never a Scan of the whole table
    // (which would page through every counter the studio has ever written).
    await this.db.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: {
          pk: s(TITLES_INDEX_PK),
          sk: s(titlePk(titleId)),
          name: s(name),
          createdAt: s(createdAt),
        },
      }),
    );
    return { title, key };
  }

  async list(): Promise<TitleSummary[]> {
    const out = await this.db.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :p",
        ExpressionAttributeValues: { ":p": s(TITLES_INDEX_PK) },
      }),
    );
    const ids = (out.Items ?? [])
      .map((it: Record<string, AttributeValue>) => (it.sk?.S ?? "").replace(/^title#/, ""))
      .filter((id: string) => TITLE_ID_RE.test(id));
    // Read each meta row so caps + grace windows are the live values, not a stale copy in
    // the registry row (the registry only carries what makes the list renderable).
    const metas = await Promise.all(ids.map((id: string) => this.get(id)));
    return metas.filter((m): m is TitleSummary => m !== null);
  }

  async get(titleId: string): Promise<TitleSummary | null> {
    if (!TITLE_ID_RE.test(titleId)) return null;
    const out = await this.db.send(
      new GetItemCommand({ TableName: this.tableName, Key: { pk: s(titlePk(titleId)), sk: s(SK_META) } }),
    );
    const item = out.Item as Record<string, AttributeValue> | undefined;
    if (!item) return null;
    const graceUntil = item.keyHash2ValidUntil?.S;
    return {
      titleId,
      name: item.name?.S ?? "",
      createdAt: item.createdAt?.S ?? "",
      eventCap: readN(item.eventCap, DEFAULT_EVENT_CAP),
      cardCap: readN(item.cardCap, DEFAULT_CARD_CAP),
      // Only surface a grace window that hasn't lapsed.
      ...(graceUntil && Date.parse(graceUntil) > this.nowMs() ? { previousKeyValidUntil: graceUntil } : {}),
    };
  }

  /**
   * Issue a new key. The OUTGOING key keeps working for KEY_GRACE_DAYS so already-shipped
   * builds don't start 403ing the moment the developer clicks rotate.
   */
  async rotateKey(titleId: string): Promise<{ key: string; previousKeyValidUntil: string }> {
    const existing = await this.get(titleId);
    if (!existing) throw new Error("No such title.");
    const key = generateKey();
    const validUntil = new Date(this.nowMs() + KEY_GRACE_DAYS * 86_400_000).toISOString();
    await this.db.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { pk: s(titlePk(titleId)), sk: s(SK_META) },
        // keyHash2 := the CURRENT hash, then keyHash := the new one. Order matters and
        // DynamoDB evaluates the whole SET against the pre-update item, so this is safe.
        UpdateExpression: "SET keyHash2 = keyHash, keyHash = :new, keyHash2ValidUntil = :until",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: { ":new": s(sha256Hex(key)), ":until": s(validUntil) },
      }),
    );
    return { key, previousKeyValidUntil: validUntil };
  }

  /** Drop the outgoing key immediately (used when a key is believed leaked). */
  async revokePreviousKey(titleId: string): Promise<void> {
    await this.db.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { pk: s(titlePk(titleId)), sk: s(SK_META) },
        UpdateExpression: "REMOVE keyHash2, keyHash2ValidUntil",
        ConditionExpression: "attribute_exists(pk)",
      }),
    );
  }

  /** Set the bill-protection caps. Both are floored at 1 — a zero cap would silently
   * black-hole a live game's telemetry. */
  async setCaps(titleId: string, caps: { eventCap?: number; cardCap?: number }): Promise<TitleSummary> {
    const existing = await this.get(titleId);
    if (!existing) throw new Error("No such title.");
    const eventCap = Math.max(1, Math.floor(caps.eventCap ?? existing.eventCap));
    const cardCap = Math.max(1, Math.floor(caps.cardCap ?? existing.cardCap));
    await this.db.send(
      new UpdateItemCommand({
        TableName: this.tableName,
        Key: { pk: s(titlePk(titleId)), sk: s(SK_META) },
        UpdateExpression: "SET eventCap = :e, cardCap = :c",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: { ":e": n(eventCap), ":c": n(cardCap) },
      }),
    );
    return { ...existing, eventCap, cardCap };
  }

  /**
   * Remove a title from the registry and delete its meta row. Counter rows are left to
   * their own devices deliberately: they are the studio's historical data, they carry no
   * player identifiers, and a synchronous delete of an arbitrarily large key range would
   * be an unbounded operation behind a button click. The UI says so plainly.
   */
  async remove(titleId: string): Promise<void> {
    await this.db.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: { pk: s(TITLES_INDEX_PK), sk: s(titlePk(titleId)) },
      }),
    );
    await this.db.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: { pk: s(titlePk(titleId)), sk: s(SK_META) },
      }),
    );
  }
}
