import pino from "pino";
import { env } from "../env.js";

// Structured logger — always plain JSON on stdout, with NO transport.
//
// A pino transport (e.g. pino-pretty) runs in a worker thread and must be
// resolvable at runtime. In production (Railway) devDependencies aren't
// installed, so a pretty-print transport would fail to load and crash the
// process on boot. Keeping the logger transport-free means it can't break the
// deploy regardless of how NODE_ENV is configured. For readable local output,
// the `dev` npm script pipes this JSON through pino-pretty.
export const logger = pino({
  level: env.isTest ? "silent" : process.env.LOG_LEVEL ?? "info",
  // pino's default request serializer includes headers; strip credentials so a
  // bearer token or cookie never lands in the logs.
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie"],
    remove: true,
  },
});
