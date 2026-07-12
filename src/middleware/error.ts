import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../lib/errors.js";
import { env } from "../env.js";

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (!env.isTest) console.error(err);
  res.status(500).json({
    error: { code: "INTERNAL", message: "Something went wrong" },
  });
}
