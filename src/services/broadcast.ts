import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { sendPushToTokens, type PushMessage } from "../lib/push.js";

// Platform-wide announcements (currently: Barber of the Week).
//
// The naive version of this — load every user id, insert a notification row per
// user inside one transaction, then fire a single FCM multicast to everyone —
// is a self-inflicted denial of service. It holds a transaction open across the
// whole user table, and the push lands on every device at the same instant.
// Each app open then costs ~3 requests on the home screen plus ~2 more if the
// customer taps through to quick-book, so a broadcast to N users produces a
// spike of roughly 3-5N requests inside a minute or two. On a single small
// instance that is the shape of an outage, and it is entirely self-triggered.
//
// So the work is split into two phases with different pacing:
//
//   1. Feed rows are written in modest batches, back to back. These are cheap,
//      nobody is woken by them, and finishing fast means the in-app feed is
//      correct immediately.
//   2. Pushes — the part that actually summons traffic — are metered out in
//      chunks with a jittered delay, spreading arrivals over minutes instead of
//      milliseconds.
//
// Durability note: this runs in-process, so a redeploy mid-broadcast ends the
// push phase early. That is deliberate and safe — phase 1 has already committed
// every feed row, and push has always been best-effort. Users who miss the push
// still see the announcement next time they open the app. Making the push phase
// itself survive a restart would need a durable job table; that is worth doing
// only once broadcast volume justifies it.

const FEED_BATCH = 1_000;
// FCM multicast accepts up to 500 tokens per call.
const PUSH_BATCH = 500;
// Base gap between push batches, plus up to JITTER_MS of randomness so
// arrivals don't align into a second, smaller wave.
const PUSH_GAP_MS = 15_000;
const JITTER_MS = 5_000;

let running = false;
let aborted = false;

export function isBroadcastRunning(): boolean {
  return running;
}

// Called from the shutdown path so a redeploy doesn't leave a timer pinning the
// process open for the remainder of a long push phase.
export function abortBroadcasts(): void {
  aborted = true;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

export interface Broadcast {
  type: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface BroadcastResult {
  users: number;
  pushed: number;
}

/**
 * Write an announcement to every user's feed, then push it out gradually.
 *
 * Resolves once the feed rows are committed; the push phase continues in the
 * background. Callers get the user count immediately rather than holding an
 * admin's HTTP request open for the length of the rollout.
 */
export async function broadcastToAllUsers(msg: Broadcast): Promise<BroadcastResult> {
  if (running) {
    // Two overlapping broadcasts would double every user's feed entry and
    // stack two push waves on top of each other.
    throw new Error("A broadcast is already in progress");
  }
  running = true;
  aborted = false;

  let users = 0;
  try {
    // --- Phase 1: feed rows, keyset-paginated ------------------------------
    // Cursor by id rather than skip/take: OFFSET makes the database re-walk
    // everything it already skipped, so the last page of a large table costs
    // the most. Ordering by the primary key also means a user created mid-sweep
    // is either included once or not at all — never duplicated.
    let cursor: string | undefined;
    for (;;) {
      const batch = await prisma.user.findMany({
        select: { id: true },
        orderBy: { id: "asc" },
        take: FEED_BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (batch.length === 0) break;

      await prisma.notification.createMany({
        data: batch.map((u) => ({
          userId: u.id,
          type: msg.type,
          title: msg.title,
          body: msg.body,
        })),
      });

      users += batch.length;
      cursor = batch[batch.length - 1].id;
      if (batch.length < FEED_BATCH) break;
    }

    logger.info({ type: msg.type, users }, "broadcast feed rows written");
  } catch (err) {
    running = false;
    throw err;
  }

  // --- Phase 2: paced push, in the background -----------------------------
  void pushPhase({ title: msg.title, body: msg.body, data: msg.data })
    .catch((err) => logger.error({ err, type: msg.type }, "broadcast push phase failed"))
    .finally(() => {
      running = false;
    });

  return { users, pushed: 0 };
}

async function pushPhase(msg: PushMessage): Promise<void> {
  let cursor: string | undefined;
  let sent = 0;
  let batches = 0;

  for (;;) {
    if (aborted) {
      logger.info({ sent, batches }, "broadcast push phase aborted (shutting down)");
      return;
    }

    const rows = await prisma.deviceToken.findMany({
      select: { id: true, token: true },
      orderBy: { id: "asc" },
      take: PUSH_BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;

    await sendPushToTokens(rows.map((r) => r.token), msg);
    sent += rows.length;
    batches += 1;
    cursor = rows[rows.length - 1].id;

    if (rows.length < PUSH_BATCH) break;
    await sleep(PUSH_GAP_MS + Math.floor(Math.random() * JITTER_MS));
  }

  logger.info({ sent, batches }, "broadcast push phase complete");
}
