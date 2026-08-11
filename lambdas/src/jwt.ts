// Cognito ID-token verification for the viewer plane. SECURITY-CRITICAL and deliberately
// dependency-free: this is the ONLY thing standing between a stranger with the dashboard
// URL and a studio's private numbers.
//
// The rule that governs every line here: a token is trusted only if its SIGNATURE verifies
// against a key we fetched from the pool's own JWKS, AND every claim we care about matches.
// Anything unexpected is a rejection, never a "probably fine" — the classic JWT failures
// (accepting `alg: none`, trusting the header's algorithm, skipping `aud`/`iss`, ignoring
// expiry) are all "we didn't check" bugs, so this checks, in order, and returns a plain
// reason string that the caller may log but must never echo to the client.

import { createPublicKey, createVerify } from "node:crypto";

export interface VerifiedViewer {
  /** Cognito `sub` — the stable user id. */
  sub: string;
  email: string;
}

export interface JwkKey {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

/** Everything the verifier needs, injected so tests never touch the network. */
export interface VerifyContext {
  /** Fetch the pool's signing keys (cached by the caller). */
  keys: JwkKey[];
  /** `https://cognito-idp.<region>.amazonaws.com/<poolId>` */
  issuer: string;
  /** The app client id — a token minted for a DIFFERENT client must not be accepted. */
  audience: string;
  /** Seconds since epoch. Injected so expiry is testable without clock games. */
  now: number;
}

function b64urlToBuffer(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function jwkToPem(jwk: JwkKey): string {
  // Node can import a JWK directly — no hand-rolled ASN.1, which is where key parsing
  // usually goes wrong.
  return createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" })
    .export({ type: "spki", format: "pem" })
    .toString();
}

/**
 * Verify a Cognito ID token. Returns the viewer on success, or `{ error }` with a short
 * reason. NEVER throws for a bad token — a malformed token is an expected event on a public
 * endpoint, not an exception.
 */
export function verifyIdToken(token: string, ctx: VerifyContext): { viewer: VerifiedViewer } | { error: string } {
  const parts = token.split(".");
  if (parts.length !== 3) return { error: "malformed token" };
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlToBuffer(headerB64).toString("utf8"));
    payload = JSON.parse(b64urlToBuffer(payloadB64).toString("utf8"));
  } catch {
    return { error: "unparseable token" };
  }

  // Pin the algorithm to what Cognito actually signs with. Taking the algorithm from the
  // header is the canonical JWT vulnerability: `alg: none` forges anything, and `HS256`
  // lets an attacker sign with the PUBLIC key as if it were an HMAC secret.
  if (header.alg !== "RS256") return { error: "unexpected alg" };
  if (!header.kid) return { error: "no kid" };

  const jwk = ctx.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { error: "unknown kid" };
  if (jwk.kty !== "RSA") return { error: "unexpected key type" };

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  if (!verifier.verify(jwkToPem(jwk), b64urlToBuffer(signatureB64))) return { error: "bad signature" };

  // Signature is good — now the claims. Order doesn't matter for safety here (all are
  // checked), but each one closes a real hole.
  if (payload.iss !== ctx.issuer) return { error: "wrong issuer" };
  // An ID token from another app client in the same pool must not open this dashboard.
  if (payload.aud !== ctx.audience) return { error: "wrong audience" };
  // Access tokens carry different claims and different guarantees; only ID tokens here.
  if (payload.token_use !== "id") return { error: "not an id token" };
  if (typeof payload.exp !== "number" || payload.exp <= ctx.now) return { error: "expired" };
  // A token minted in the future is a clock problem or a forgery attempt; either way, no.
  if (typeof payload.iat === "number" && payload.iat > ctx.now + 300) return { error: "issued in the future" };

  const sub = typeof payload.sub === "string" ? payload.sub : "";
  const email = typeof payload.email === "string" ? payload.email : "";
  if (!sub) return { error: "no subject" };

  return { viewer: { sub, email } };
}

/** The issuer string Cognito puts in every token from this pool. */
export function issuerFor(region: string, userPoolId: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}

/** Where that pool publishes its signing keys. */
export function jwksUrlFor(region: string, userPoolId: string): string {
  return `${issuerFor(region, userPoolId)}/.well-known/jwks.json`;
}
