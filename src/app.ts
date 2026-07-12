import express from "express";
// Patches Express 4 so rejected async handlers reach the error middleware.
import "express-async-errors";
import helmet from "helmet";
import cors from "cors";
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

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // correct client IPs for rate limiting behind a proxy

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins }));
  app.use(express.json({ limit: "256kb" }));
  app.use(generalLimiter);

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
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
