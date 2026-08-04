import jwt, { type JwtPayload } from "jsonwebtoken";
import { createPublicKey, type KeyObject } from "node:crypto";
import { env } from "../env.js";
import { ApiError } from "./errors.js";
import { logger } from "./logger.js";

// Verified identity extracted from an Apple identity token. Note the name is
// NOT in the token: Apple returns it to the client once, on the first
// authorization only, so it arrives on the request body instead.
export interface AppleIdentity {
  appleId: string; // `sub` claim — stable per Apple account
  email: string | null; // may be a @privaterelay.appleid.com relay, or absent
  isPrivateEmail: boolean;
}

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";

interface AppleJwk {
  kty: string;
  kid: string;
  use: string;
  alg: string;
  n: string;
  e: string;
}

// Apple rotates its signing keys, so cache the JWKS for an hour and refetch on
// a kid miss (a rotation) before giving up.
let cachedKeys: { keys: AppleJwk[]; fetchedAt: number } | null = null;
const KEYS_TTL_MS = 60 * 60 * 1000;

// Apple's JWKS endpoint is on the login path. Cap the fetch so an unreachable
// Apple stalls one request briefly rather than holding a connection for the
// full server request timeout.
const KEYS_FETCH_TIMEOUT_MS = 8_000;

async function fetchAppleKeys(force = false): Promise<AppleJwk[]> {
  if (!force && cachedKeys && Date.now() - cachedKeys.fetchedAt < KEYS_TTL_MS) {
    return cachedKeys.keys;
  }
  let res: Response;
  try {
    res = await fetch(APPLE_KEYS_URL, {
      signal: AbortSignal.timeout(KEYS_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // Serve a stale cache rather than failing every sign-in during an Apple
    // blip: these keys rotate on the order of months, so an hour-old copy is
    // still overwhelmingly likely to verify the token in hand.
    if (cachedKeys) {
      logger.warn({ err }, "Apple JWKS fetch failed — using cached keys");
      return cachedKeys.keys;
    }
    throw new ApiError(
      503,
      "APPLE_UNAVAILABLE",
      "Could not reach Apple to verify your sign-in. Try again.",
    );
  }
  if (!res.ok) {
    if (cachedKeys) {
      logger.warn({ status: res.status }, "Apple JWKS returned an error — using cached keys");
      return cachedKeys.keys;
    }
    throw new Error(`Apple JWKS fetch failed: ${res.status}`);
  }
  const body = (await res.json()) as { keys: AppleJwk[] };
  cachedKeys = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

async function publicKeyForKid(kid: string): Promise<KeyObject> {
  let jwk = (await fetchAppleKeys()).find((k) => k.kid === kid);
  if (!jwk) jwk = (await fetchAppleKeys(true)).find((k) => k.kid === kid);
  if (!jwk) {
    throw ApiError.unauthorized("Apple sign-in failed", "APPLE_TOKEN_INVALID");
  }
  // Node imports a JWK directly (>=16); the extra kid/use/alg fields are
  // ignored. Cast via the function's own parameter type so this compiles
  // without the DOM lib (which is where the global `JsonWebKey` type lives).
  return createPublicKey({ key: jwk, format: "jwk" } as unknown as Parameters<
    typeof createPublicKey
  >[0]);
}

// Apple sends some boolean claims as the strings "true"/"false".
function asBool(v: unknown): boolean {
  return v === true || v === "true";
}

export async function verifyAppleIdToken(identityToken: string): Promise<AppleIdentity> {
  const decoded = jwt.decode(identityToken, { complete: true });
  if (!decoded || typeof decoded === "string" || !decoded.header.kid) {
    throw ApiError.unauthorized("Apple sign-in failed", "APPLE_TOKEN_INVALID");
  }

  const key = await publicKeyForKid(decoded.header.kid);

  let payload: JwtPayload;
  try {
    payload = jwt.verify(identityToken, key, {
      algorithms: ["RS256"],
      issuer: APPLE_ISSUER,
      // jsonwebtoken types want a single value or a non-empty tuple; appleClientIds
      // always carries at least the default bundle id, so the assertion is safe.
      audience: env.appleClientIds as [string, ...string[]],
    }) as JwtPayload;
  } catch {
    throw ApiError.unauthorized("Apple sign-in failed", "APPLE_TOKEN_INVALID");
  }

  if (!payload.sub) {
    throw ApiError.unauthorized("Apple sign-in failed", "APPLE_TOKEN_INVALID");
  }

  const email =
    typeof payload.email === "string" ? payload.email.toLowerCase() : null;
  // Apple owns the address it issues (real or relay), so a present email can be
  // trusted — but only if its verification bit is set. An unverified email must
  // not link to an existing account, since barbers are matched by email.
  if (email && !asBool((payload as Record<string, unknown>).email_verified)) {
    throw ApiError.unauthorized(
      "Apple account email is not verified",
      "APPLE_EMAIL_UNVERIFIED",
    );
  }

  return {
    appleId: payload.sub,
    email,
    isPrivateEmail: asBool((payload as Record<string, unknown>).is_private_email),
  };
}
