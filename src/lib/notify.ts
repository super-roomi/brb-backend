import { prisma } from "./prisma.js";
import { sendPushToUser } from "./push.js";
import { logger } from "./logger.js";
import { parseLang, type Lang } from "./localize.js";
import { type NotificationText } from "./notificationMessages.js";

export interface NotifyOptions {
  userId: string;
  type: string; // BOOKING_ACCEPTED | BOOKING_DECLINED | NEW_RESERVATION | BOOKING_REMINDER
  reservationId?: string;
  // Builds the localized copy for the recipient. Called with the recipient's
  // preferred language, so content names inside can be localized to match.
  build: (lang: Lang) => NotificationText;
  // Skip the language lookup when the caller already has it (e.g. the reminder
  // sweep selects it alongside the reservation).
  lang?: Lang;
}

// Records an in-app notification and fires a matching push, both in the
// recipient's language. Best-effort: a failed row write or push must never
// break the request that triggered it, so callers use `void notifyUser(...)`.
export async function notifyUser(opts: NotifyOptions): Promise<void> {
  let lang: Lang = opts.lang ?? "en";
  if (!opts.lang) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: opts.userId },
        select: { lang: true },
      });
      lang = parseLang(user?.lang);
    } catch {
      // Fall back to English if the lookup fails.
    }
  }

  const { title, body } = opts.build(lang);

  try {
    await prisma.notification.create({
      data: {
        userId: opts.userId,
        type: opts.type,
        title,
        body,
        reservationId: opts.reservationId ?? null,
      },
    });
  } catch (err) {
    logger.error({ err, type: opts.type }, "notification row write failed");
  }

  void sendPushToUser(opts.userId, {
    title,
    body,
    data: {
      type: opts.type,
      ...(opts.reservationId ? { reservationId: opts.reservationId } : {}),
    },
  });
}
