import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken, verifyAdminToken } from "../lib/jwt.js";
import { ApiError } from "../lib/errors.js";

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; role: "user" | "admin" };
    }
  }
}

export function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

function extract(req: Request): string {
  const token = bearerToken(req);
  if (!token) throw ApiError.unauthorized();
  return token;
}

export function requireUser(req: Request, _res: Response, next: NextFunction) {
  const claims = verifyAccessToken(extract(req));
  req.auth = { userId: claims.sub, role: claims.role };
  next();
}

// Admin tokens verify against their own secret and audience (see lib/jwt.ts),
// so a customer token can never satisfy this — the role check is now a
// belt-and-braces assertion rather than the only barrier.
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const claims = verifyAdminToken(extract(req));
  if (claims.role !== "admin") throw ApiError.forbidden("Admin access required");
  req.auth = { userId: claims.sub, role: claims.role };
  next();
}
