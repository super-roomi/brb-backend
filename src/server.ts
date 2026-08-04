import { createApp, beginDraining } from "./app.js";
import { env } from "./env.js";
import { prisma } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";
import { startReminderScheduler, stopReminderScheduler } from "./services/reminders.js";
import { startRetentionScheduler, stopRetentionScheduler } from "./services/maintenance.js";
import { abortBroadcasts } from "./services/broadcast.js";

const app = createApp();

const server = app.listen(env.port, () => {
  // Appointment reminders run in-process (the web service stays up); the
  // reminderSentAt claim keeps it correct even if more than one instance runs.
  startReminderScheduler();
  // Nightly retention sweep — RefreshToken/Notification/AuditLog would
  // otherwise grow without bound. See services/maintenance.ts.
  startRetentionScheduler();
  logger.info(
    {
      port: env.port,
      googleConfigured: env.googleConfigured,
      testLoginEnabled: env.testLoginEnabled,
      dbConnectionLimit: env.dbConnectionLimit,
    },
    "Barber API listening",
  );
  if (env.testLoginEnabled) {
    logger.warn(
      "Password-less /api/auth/test-login is registered (non-production build). " +
        "It signs in as ANY email — never run this build against production data.",
    );
  }
  if (!env.googleConfigured) {
    logger.warn(
      env.testLoginEnabled
        ? "GOOGLE_CLIENT_ID is the placeholder — Google sign-in will fail; use /api/auth/test-login for development"
        : "GOOGLE_CLIENT_ID is the placeholder — Google sign-in WILL FAIL for every user. Set it.",
    );
  }
});

// Don't let a slow/stuck client hold a socket forever.
server.requestTimeout = 30_000;

// Keep-alive must OUTLIVE the upstream proxy's idle timeout. If the proxy
// reuses a connection at the same moment Node decides to close it, the client
// gets a 502 that nothing in the application logs explains. Erring long is
// safe; erring short produces intermittent, unattributable errors under load.
// headersTimeout must exceed keepAliveTimeout or Node closes sockets early.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

// Graceful shutdown: stop advertising readiness, let the load balancer notice,
// drain in-flight requests, then close the DB pool. Without this, every deploy
// hard-drops live requests.
let shuttingDown = false;
// How long to keep serving after readiness starts failing, so the load balancer
// has time to pull this instance out of rotation before the socket closes.
const DRAIN_GRACE_MS = env.isProd ? 5_000 : 0;
// Hard ceiling on the whole shutdown, comfortably under the 30s most platforms
// allow between SIGTERM and SIGKILL.
const SHUTDOWN_DEADLINE_MS = 25_000;

async function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");

  // 1. Fail readiness immediately so no NEW requests get routed here.
  beginDraining();
  // 2. Stop background work that would otherwise start fresh writes mid-drain.
  stopReminderScheduler();
  stopRetentionScheduler();
  abortBroadcasts();

  // Failsafe: never hang forever if a connection won't close.
  const deadline = setTimeout(() => {
    logger.error("shutdown deadline exceeded — forcing exit");
    process.exit(exitCode || 1);
  }, SHUTDOWN_DEADLINE_MS);
  deadline.unref();

  // 3. Give the load balancer a moment to act on the failing health check.
  if (DRAIN_GRACE_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, DRAIN_GRACE_MS));
  }

  // 4. Stop accepting connections and wait for in-flight requests to finish.
  await new Promise<void>((resolve) => server.close(() => resolve()));

  try {
    await prisma.$disconnect();
  } catch (err) {
    logger.warn({ err }, "prisma disconnect failed during shutdown");
  }

  clearTimeout(deadline);
  process.exit(exitCode);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// A process that has thrown an uncaught exception has unknown state — some
// request handler stopped halfway through. Continuing to serve from it risks
// corrupt writes and confusing half-responses, so drain and exit non-zero and
// let the platform start a clean instance. Logging and exiting beats both
// silently dying (no diagnosis) and soldiering on (worse than a restart).
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception — shutting down");
  void shutdown("uncaughtException", 1);
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled promise rejection — shutting down");
  void shutdown("unhandledRejection", 1);
});
