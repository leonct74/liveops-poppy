// The verifier is the whole security boundary of the team dashboard, so these tests are
// adversarial: every case here is an attack that has worked on real JWT implementations.
import { describe, expect, it } from "vitest";
import { createSign, generateKeyPairSync } from "node:crypto";
import { issuerFor, jwksUrlFor, verifyIdToken, type JwkKey } from "./jwt";

const ISSUER = issuerFor("eu-west-1", "eu-west-1_ABC123");
const AUDIENCE = "client-abc";
const NOW = 1_800_000_000;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as unknown as { n: string; e: string };
const KEYS: JwkKey[] = [{ kid: "key-1", kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256" }];

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function sign(payload: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const h = b64({ alg: "RS256", kid: "key-1", ...header });
  const p = b64(payload);
  const s = createSign("RSA-SHA256");
  s.update(`${h}.${p}`);
  s.end();
  return `${h}.${p}.${s.sign(privateKey).toString("base64url")}`;
}

const goodPayload = {
  iss: ISSUER,
  aud: AUDIENCE,
  token_use: "id",
  exp: NOW + 3600,
  iat: NOW - 10,
  sub: "user-1",
  email: "producer@studio.example",
};
const ctx = { keys: KEYS, issuer: ISSUER, audience: AUDIENCE, now: NOW };

describe("verifyIdToken", () => {
  it("accepts a correctly signed, current ID token", () => {
    const r = verifyIdToken(sign(goodPayload), ctx);
    expect(r).toEqual({ viewer: { sub: "user-1", email: "producer@studio.example" } });
  });

  // THE canonical JWT attack: strip the signature and claim there is no algorithm.
  it("refuses alg:none even with a well-formed payload", () => {
    const h = b64({ alg: "none", kid: "key-1" });
    const p = b64(goodPayload);
    expect(verifyIdToken(`${h}.${p}.`, ctx)).toEqual({ error: "unexpected alg" });
  });

  // The second canonical attack: sign with HMAC using the public key as the secret.
  it("refuses HS256 (public key as HMAC secret)", () => {
    const r = verifyIdToken(sign(goodPayload, { alg: "HS256" }), ctx);
    expect(r).toEqual({ error: "unexpected alg" });
  });

  it("refuses a token signed by a DIFFERENT key", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const h = b64({ alg: "RS256", kid: "key-1" });
    const p = b64(goodPayload);
    const s = createSign("RSA-SHA256");
    s.update(`${h}.${p}`);
    s.end();
    const forged = `${h}.${p}.${s.sign(other.privateKey).toString("base64url")}`;
    expect(verifyIdToken(forged, ctx)).toEqual({ error: "bad signature" });
  });

  it("refuses a tampered payload (same signature, edited claims)", () => {
    const token = sign(goodPayload);
    const [h, , s] = token.split(".");
    const tampered = `${h}.${b64({ ...goodPayload, email: "attacker@evil.example" })}.${s}`;
    expect(verifyIdToken(tampered, ctx)).toEqual({ error: "bad signature" });
  });

  it("refuses an unknown kid rather than trying every key", () => {
    expect(verifyIdToken(sign(goodPayload, { kid: "key-99" }), ctx)).toEqual({ error: "unknown kid" });
  });

  it("refuses an expired token", () => {
    expect(verifyIdToken(sign({ ...goodPayload, exp: NOW - 1 }), ctx)).toEqual({ error: "expired" });
  });

  it("refuses another pool's token (wrong issuer)", () => {
    const r = verifyIdToken(sign({ ...goodPayload, iss: issuerFor("eu-west-1", "eu-west-1_OTHER") }), ctx);
    expect(r).toEqual({ error: "wrong issuer" });
  });

  // Same pool, different app client — e.g. a token minted for some other integration.
  it("refuses another client's token (wrong audience)", () => {
    expect(verifyIdToken(sign({ ...goodPayload, aud: "client-xyz" }), ctx)).toEqual({ error: "wrong audience" });
  });

  it("refuses an ACCESS token — only ID tokens carry the identity we check", () => {
    expect(verifyIdToken(sign({ ...goodPayload, token_use: "access" }), ctx)).toEqual({
      error: "not an id token",
    });
  });

  it("refuses a token issued far in the future", () => {
    expect(verifyIdToken(sign({ ...goodPayload, iat: NOW + 3600 }), ctx)).toEqual({
      error: "issued in the future",
    });
  });

  it("never throws on garbage — a public endpoint sees garbage constantly", () => {
    for (const junk of ["", "abc", "a.b", "a.b.c", "....", "%%%.###.@@@"]) {
      expect(() => verifyIdToken(junk, ctx)).not.toThrow();
      expect(verifyIdToken(junk, ctx)).toHaveProperty("error");
    }
  });

  it("builds the issuer and JWKS URLs Cognito actually uses", () => {
    expect(ISSUER).toBe("https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_ABC123");
    expect(jwksUrlFor("eu-west-1", "eu-west-1_ABC123")).toBe(`${ISSUER}/.well-known/jwks.json`);
  });
});
