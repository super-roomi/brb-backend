import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import { Prisma } from "@prisma/client";
import { ApiError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { TimeoutError } from "../lib/timeout.js";

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
}

// Infrastructure failures that are worth retrying. Returning 500 for these
// tells the client "this request was malformed or the server is broken", when
// the truth is "try again in a moment" — and the app's error handling can only
// act on the difference if we say which one it is.
function transientResponse(err: unknown):
  | { status: number; code: string; message: string; retryAfterSec: number }
  | null {
  if (err instanceof TimeoutError) {
    return {
      status: 504,
      code: "UPSTREAM_TIMEOUT",
      message: "That took too long. Try again.",
      retryAfterSec: 2,
    };
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P1001/P1002: database unreachable or timed out. P2024: the connection
    // pool is exhausted — a load symptom, not a bug in the request.
    if (err.code === "P1001" || err.code === "P1002" || err.code === "P2024") {
      return {
        status: 503,
        code: "DB_UNAVAILABLE",
        message: "The service is busy. Try again in a moment.",
        retryAfterSec: 5,
      };
    }
    // P2034: write conflict/deadlock that escaped a retry loop.
    if (err.code === "P2034") {
      return {
        status: 409,
        code: "WRITE_CONFLICT",
        message: "That just changed. Refresh and try again.",
        retryAfterSec: 1,
      };
    }
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    return {
      status: 503,
      code: "DB_UNAVAILABLE",
      message: "The service is starting up. Try again in a moment.",
      retryAfterSec: 5,
    };
  }
  return null;
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

  const log = (req as Request & { log?: Logger }).log ?? logger;

  const transient = transientResponse(err);
  if (transient) {
    // Warn, not error: this is load or a dependency having a moment, and
    // paging on it at error level buries genuine bugs.
    log.warn({ err, code: transient.code }, "transient failure");
    res.setHeader("Retry-After", String(transient.retryAfterSec));
    res.status(transient.status).json({
      error: { code: transient.code, message: transient.message },
    });
    return;
  }

  // Unexpected error: log it with the request-scoped logger (carries the request
  // id) when present, else the shared logger. Silent under test (logger level).
  log.error({ err }, "Unhandled error");
  res.status(500).json({
    error: { code: "INTERNAL", message: "Something went wrong" },
  });
}
