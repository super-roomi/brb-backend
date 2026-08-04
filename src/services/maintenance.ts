import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { env } from "../env.js";

// Nightly retention sweep.
//
// Three tables here are append-mostly and were never trimmed:
//
//   RefreshToken  one row per token refresh per device. With a 15-minute access
//                 TTL that is ~96 rows/day for an active device, so a few
//                 thousand daily users fill a small database's disk within
//                 months. Expired and revoked rows have no purpose — rotation
//                 already revokes the whole family on replay, so a spent row
//                 proves nothing after its expiry.
//   Notification  the feed only ever renders the newest 50, and the
//                 Barber-of-the-Week broadcast writes one row per user per run.
//   AuditLog      kept far longer (it is the compliance artifact) but not forever.
//
// Deletes are chunked: a single unbounded DELETE on a large table takes a long
// lock and can time out against the statement timeout, leaving nothing cleaned.
// Chunking means each pass makes progress even if it is interrupted.

const CHUNK = 5_000;
// Cap work per run so the sweep can never monopolise the instance. Whatever is
// left is picked up by the next run.
const MAX_CHUNKS_PER_TABLE = 20;
const DAY_MS = 86_400_000;

async function deleteInChunks(
  label: string,
  deleteChunk: (limit: number) => Promise<number>,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_CHUNKS_PER_TABLE; i++) {
    const removed = await deleteChunk(CHUNK);
    total += removed;
    if (removed < CHUNK) break;
  }
  if (total > 0) logger.info({ table: label, removed: total }, "retention sweep removed rows");
  return total;
}

// Prisma has no LIMIT on deleteMany, so select the ids first and delete by id.
// That also keeps each statement's lock footprint predictable.
async function deleteExpiredRefreshTokens(limit: number): Promise<number> {
  const rows = await prisma.refreshToken.findMany({
    where: { expiresAt: { lt: new Date() } },
    select: { id: true },
    take: limit,
  });
  if (rows.length === 0) return 0;
  const { count } = await prisma.refreshToken.deleteMany({
    where: { id: { in: rows.map((r) => r.id) } },
  });
  return count;
}

async function deleteOldNotifications(limit: number): Promise<number> {
  const cutoff = new Date(Date.now() - env.notificationRetentionDays * DAY_MS);
  const rows = await prisma.notification.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true },
    take: limit,
  });
  if (rows.length === 0) return 0;
  const { count } = await prisma.notification.deleteMany({
    where: { id: { in: rows.map((r) => r.id) } },
  });
  return count;
}

async function deleteOldAuditLogs(limit: number): Promise<number> {
  const cutoff = new Date(Date.now() - env.auditRetentionDays * DAY_MS);
  const rows = await prisma.auditLog.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true },
    take: limit,
  });
  if (rows.length === 0) return 0;
  const { count } = await prisma.auditLog.deleteMany({
    where: { id: { in: rows.map((r) => r.id) } },
  });
  return count;
}

export async function runRetentionSweep(): Promise<void> {
  try {
    await deleteInChunks("RefreshToken", deleteExpiredRefreshTokens);
    await deleteInChunks("Notification", deleteOldNotifications);
    await deleteInChunks("AuditLog", deleteOldAuditLogs);
  } catch (err) {
    // Never throw from a background timer: an unhandled rejection here would
    // take down the process via the crash handler in server.ts.
    logger.error({ err }, "retention sweep failed");
  }
}

let timer: NodeJS.Timeout | null = null;

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h
// Delay the first sweep past boot so a deploy isn't competing with cleanup
// while it is also warming caches and re-establishing connections.
const FIRST_SWEEP_DELAY_MS = 5 * 60 * 1000;

export function startRetentionScheduler(): void {
  if (timer) return;
  setTimeout(() => void runRetentionSweep(), FIRST_SWEEP_DELAY_MS).unref?.();
  timer = setInterval(() => void runRetentionSweep(), SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopRetentionScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
