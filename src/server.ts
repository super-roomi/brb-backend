import { createApp } from "./app.js";
import { env } from "./env.js";
import { prisma } from "./lib/prisma.js";
import { logger } from "./lib/logger.js";

const app = createApp();

const server = app.listen(env.port, () => {
  logger.info({ port: env.port, smsProvider: env.smsProvider }, "Barber API listening");
  if (env.smsProvider === "console") logger.info("SMS provider is console — OTP codes print here");
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
