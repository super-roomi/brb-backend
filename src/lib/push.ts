import admin from "firebase-admin";
import { prisma } from "./prisma.js";
import { logger } from "./logger.js";

// Firebase Cloud Messaging (Android push). Best-effort: if FCM isn't configured
// (no service-account credential), every function here is a silent no-op, so
// tests/dev and any deploy without the secret keep working — the in-app
// notification feed remains the source of truth.

let messaging: admin.messaging.Messaging | null = null;
let initialized = false;

function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (raw) {
      // Inline JSON (recommended on Fly/Railway — set as a secret).
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      // Path to a service-account file (auto-read by the SDK).
      admin.initializeApp({ credential: admin.credential.applicationDefault() });
    } else {
      logger.info("FCM not configured (no FIREBASE_SERVICE_ACCOUNT) — push disabled");
      return;
    }
    messaging = admin.messaging();
    logger.info("FCM push initialized");
  } catch (err) {
    logger.error({ err }, "FCM init failed — push disabled");
    messaging = null;
  }
}

export type PushMessage = { title: string; body: string; data?: Record<string, string> };

export function sendPushToUser(userId: string, msg: PushMessage): Promise<void> {
  return sendPushToUsers([userId], msg);
}

// Never throws — safe to call fire-and-forget (`void sendPushToUsers(...)`).
export async function sendPushToUsers(userIds: string[], msg: PushMessage): Promise<void> {
  try {
    ensureInit();
    if (!messaging || userIds.length === 0) return;
    const rows = await prisma.deviceToken.findMany({
      where: { userId: { in: userIds } },
      select: { token: true },
    });
    const tokens = rows.map((r) => r.token);
    if (tokens.length === 0) return;
    await sendToTokens(messaging, tokens, msg);
  } catch (err) {
    logger.error({ err }, "push send failed");
  }
}

async function sendToTokens(
  m: admin.messaging.Messaging,
  tokens: string[],
  msg: PushMessage,
): Promise<void> {
  const invalid: string[] = [];
  // FCM multicast accepts up to 500 tokens per call.
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const res = await m.sendEachForMulticast({
      tokens: chunk,
      notification: { title: msg.title, body: msg.body },
      data: msg.data,
      // No channelId: let the FCM SDK use its auto-created default channel so
      // notifications always show on Android 8+ without app-side channel setup.
      android: { priority: "high" },
    });
    res.responses.forEach((r, idx) => {
      if (
        !r.success &&
        (r.error?.code === "messaging/registration-token-not-registered" ||
          r.error?.code === "messaging/invalid-argument")
      ) {
        invalid.push(chunk[idx]);
      }
    });
  }
  // Prune tokens the device/app no longer owns so we stop sending to them.
  if (invalid.length > 0) {
    await prisma.deviceToken.deleteMany({ where: { token: { in: invalid } } }).catch(() => {});
  }
}
