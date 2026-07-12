import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { env } from "../env.js";
import { ApiError } from "./errors.js";

export type AccessClaims = { sub: string; role: "user" | "admin" };

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign({ role: claims.role }, env.accessSecret, {
    subject: claims.sub,
    expiresIn: env.accessTtl,
    audience: "barber-api",
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessClaims {
  try {
    const payload = jwt.verify(token, env.accessSecret, {
      audience: "barber-api",
    }) as jwt.JwtPayload;
    return { sub: payload.sub as string, role: payload.role };
  } catch {
    throw ApiError.unauthorized("Invalid or expired token", "TOKEN_INVALID");
  }
}

// Refresh tokens are opaque random strings; only their SHA-256 hash is stored,
// so a database leak does not leak usable tokens.
export function newRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(48).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
