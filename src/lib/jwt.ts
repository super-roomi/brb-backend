import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { env } from "../env.js";
import { ApiError } from "./errors.js";

export type Role = "user" | "admin";
export type AccessClaims = { sub: string; role: Role };

// Customer and admin tokens are signed with SEPARATE secrets and carry
// different audiences. Previously both shared one secret and were told apart
// only by a `role` claim, which meant a single leaked secret handed out
// platform admin — and any bug that let a `role` value be influenced was a
// privilege escalation. Now an admin token simply does not verify against the
// customer secret, and vice versa.
const USER_AUDIENCE = "barber-api";
const ADMIN_AUDIENCE = "barber-admin";

export function signAccessToken(claims: AccessClaims, expiresIn = env.accessTtl): string {
  return jwt.sign({ role: claims.role }, env.accessSecret, {
    subject: claims.sub,
    expiresIn,
    audience: USER_AUDIENCE,
  } as jwt.SignOptions);
}

export function signAdminToken(adminId: string, expiresIn = env.adminAccessTtl): string {
  return jwt.sign({ role: "admin" }, env.adminSecret, {
    subject: adminId,
    expiresIn,
    audience: ADMIN_AUDIENCE,
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessClaims {
  try {
    const payload = jwt.verify(token, env.accessSecret, {
      audience: USER_AUDIENCE,
    }) as jwt.JwtPayload;
    return { sub: payload.sub as string, role: payload.role };
  } catch {
    throw ApiError.unauthorized("Invalid or expired token", "TOKEN_INVALID");
  }
}

export function verifyAdminToken(token: string): AccessClaims {
  try {
    const payload = jwt.verify(token, env.adminSecret, {
      audience: ADMIN_AUDIENCE,
    }) as jwt.JwtPayload;
    return { sub: payload.sub as string, role: "admin" };
  } catch {
    throw ApiError.unauthorized("Invalid or expired token", "TOKEN_INVALID");
  }
}

// Best-effort identity for infrastructure that runs BEFORE the auth middleware
// (the rate limiter, which needs a stable per-caller key). Returns null instead
// of throwing so an absent or bad token just falls through to IP-based keying.
export function peekUserId(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, env.accessSecret, {
      audience: USER_AUDIENCE,
    }) as jwt.JwtPayload;
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
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
