import { createApp } from "./app.js";
import { env } from "./env.js";
import { prisma } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";
import { startReminderScheduler } from "./services/reminders.js";

const app = createApp();

const server = app.listen(env.port, () => {
  // Appointment reminders run in-process (Render keeps the web service up); the
  // reminderSentAt claim keeps it correct even if more than one instance runs.
  startReminderScheduler();
  logger.info(
    {
      port: env.port,
      googleConfigured: env.googleConfigured,
      testLoginEnabled: env.testLoginEnabled,
    },
    "Barber API listening",
  );
  if (env.isProd && env.testLoginEnabled) {
    logger.warn("ENABLE_TEST_LOGIN is on — password-less /api/auth/test-login is PUBLIC. Staging only.");
  }
  if (!env.googleConfigured) {
    logger.warn(
      "GOOGLE_CLIENT_ID is the placeholder — Google sign-in will fail; use /api/auth/test-login for development",
    );
  }
});

// Don't let a slow/stuck client hold a socket forever.
server.requestTimeout = 30_000;

// Graceful shutdown: stop accepting connections, let in-flight requests drain,
// then close the DB pool. Without this, every deploy hard-drops live requests.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  // Failsafe: don't hang forever if a connection won't close.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
