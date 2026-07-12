import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import { ApiError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  // Unexpected error: log it with the request-scoped logger (carries the request
  // id) when present, else the shared logger. Silent under test (logger level).
  const log = (req as Request & { log?: Logger }).log ?? logger;
  log.error({ err }, "Unhandled error");
  res.status(500).json({
    error: { code: "INTERNAL", message: "Something went wrong" },
  });
}
