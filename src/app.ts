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
import { prisma } from "./lib/prisma.js";

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

  // Liveness: the process is up. Cheap, never touches the DB.
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  // Readiness: the process can actually serve traffic (DB reachable). Load
  // balancers / orchestrators should gate on this one, not /health.
  app.get("/api/health/ready", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true });
    } catch {
      res.status(503).json({ error: { code: "NOT_READY", message: "Database unavailable" } });
    }
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
