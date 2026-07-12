import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../lib/jwt.js";
import { ApiError } from "../lib/errors.js";

declare global {
  namespace Express {
    interface Request {
      auth?: { userId: string; role: "user" | "admin" };
    }
  }
}

function extract(req: Request): string {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw ApiError.unauthorized();
  }
  return header.slice("Bearer ".length);
}

export function requireUser(req: Request, _res: Response, next: NextFunction) {
  const claims = verifyAccessToken(extract(req));
  req.auth = { userId: claims.sub, role: claims.role };
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const claims = verifyAccessToken(extract(req));
  if (claims.role !== "admin") throw ApiError.forbidden("Admin access required");
  req.auth = { userId: claims.sub, role: claims.role };
  next();
}
