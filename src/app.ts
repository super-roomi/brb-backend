import express from "express";
// Patches Express 4 so rejected async handlers reach the error middleware.
import "express-async-errors";
import helmet from "helmet";
import compression from "compression";
import cors from "cors";
import { pinoHttp } from "pino-http";
import { logger } from "./lib/logger.js";
import { env } from "./env.js";
import { authRouter } from "./routes/auth.js";
import { catalogRouter } from "./routes/catalog.js";
import { reservationsRouter } from "./routes/reservations.js";
import { reviewsRouter } from "./routes/reviews.js";
import { barberRouter } from "./routes/barber.js";
import { notificationsRouter } from "./routes/notifications.js";
import { adminRouter } from "./routes/admin.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { generalLimiter } from "./middleware/rateLimit.js";
import { pingDatabase } from "./lib/prisma.js";

// Flipped by the shutdown path. While true, readiness reports 503 so the load
// balancer stops sending new requests BEFORE the process stops accepting them —
// without this, every redeploy drops a handful of requests into a socket that
// is already closing.
let draining = false;

export function beginDraining(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

// Readiness runs on every load-balancer probe, so it must not become its own
// load. Cache the DB check briefly: a database that just answered is
// overwhelmingly likely to still be up 2 seconds later, and this keeps a burst
// of probes from opening a connection each.
const READY_CACHE_MS = 2_000;
let lastReady = { at: 0, ok: false };

async function databaseReady(): Promise<boolean> {
  const now = Date.now();
  if (now - lastReady.at < READY_CACHE_MS) return lastReady.ok;
  const ok = await pingDatabase();
  lastReady = { at: now, ok };
  return ok;
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // correct client IPs for rate limiting behind a proxy

  // Request logging first, so every request (including rate-limited ones) gets a
  // log line with an auto-generated request id, method, status and duration.
  // Health probes are hit constantly by load balancers — skip them as noise.
  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => req.url === "/api/health" || req.url === "/api/health/ready",
      },
    }),
  );

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins }));
  // gzip responses — shop lists/reviews compress well and the app's users are
  // mostly on cellular networks where bytes matter.
  app.use(compression());
  app.use(express.json({ limit: "256kb" }));
  app.use(generalLimiter);

  // Liveness: the process is up and the event loop is turning. Cheap, never
  // touches the DB — a liveness probe that depends on the database will
  // restart a perfectly healthy process during a database blip, turning a
  // partial outage into a crash loop.
  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  // Readiness: this instance should receive traffic right now. Gates on both
  // the drain flag and the database.
  app.get("/api/health/ready", async (_req, res) => {
    if (draining) {
      res.status(503).json({ error: { code: "DRAINING", message: "Shutting down" } });
      return;
    }
    if (await databaseReady()) {
      res.json({ ok: true });
      return;
    }
    res.status(503).json({ error: { code: "NOT_READY", message: "Database unavailable" } });
  });

  app.use("/api/auth", authRouter);
  app.use("/api", catalogRouter);
  app.use("/api/reservations", reservationsRouter);
  app.use("/api", reviewsRouter);
  app.use("/api/barber", barberRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/admin", adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
