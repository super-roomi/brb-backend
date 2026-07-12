import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";
import { ApiError } from "../lib/errors.js";

export function validate<T>(schema: ZodSchema<T>, source: "body" | "query" = "body") {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw ApiError.badRequest(
        `${first.path.join(".") || source}: ${first.message}`,
        "VALIDATION",
      );
    }
    // Stash parsed data; req.query is a getter in Express 5 land, avoid mutating.
    (req as Request & { parsed?: T }).parsed = parsed.data;
    next();
  };
}

export function parsed<T>(req: Request): T {
  return (req as Request & { parsed: T }).parsed;
}
