import { prisma } from "../lib/prisma.js";
import { notifyUser } from "../lib/notify.js";
import { logger } from "../lib/logger.js";
import { localize, parseLang } from "../lib/localize.js";
import { bookingReminder } from "../lib/notificationMessages.js";

// How far ahead of the appointment the reminder fires.
export const REMINDER_LEAD_MIN = 20;

// Send the "your appointment is soon" reminder for every confirmed booking that
// has entered the reminder window and hasn't been reminded yet. Each row is
// claimed with a compare-and-swap on reminderSentAt, so concurrent sweeps (or
// multiple server instances) can't double-send.
export async function sendDueReminders(): Promise<void> {
  try {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + REMINDER_LEAD_MIN * 60_000);
    const due = await prisma.reservation.findMany({
      where: {
        status: "CONFIRMED",
        reminderSentAt: null,
        startsAt: { gt: now, lte: windowEnd },
      },
      select: {
        id: true,
        userId: true,
        service: { select: { name: true, nameAr: true, nameCkb: true } },
        shop: { select: { name: true, nameAr: true, nameCkb: true } },
        user: { select: { lang: true } },
      },
      take: 200,
    });

    for (const r of due) {
      const claimed = await prisma.reservation.updateMany({
        where: { id: r.id, reminderSentAt: null },
        data: { reminderSentAt: now },
      });
      if (claimed.count === 0) continue; // another sweep got it first
      const lang = parseLang(r.user.lang);
      await notifyUser({
        userId: r.userId,
        type: "BOOKING_REMINDER",
        reservationId: r.id,
        lang,
        build: (l) =>
          bookingReminder(l, {
            service: localize(l, r.service.name, r.service.nameAr, r.service.nameCkb),
            shop: localize(l, r.shop.name, r.shop.nameAr, r.shop.nameCkb),
            minutes: REMINDER_LEAD_MIN,
          }),
      });
    }
  } catch (err) {
    logger.error({ err }, "reminder sweep failed");
  }
}

let timer: NodeJS.Timeout | null = null;

// Start the once-a-minute reminder sweep. The 20-min window plus the
// reminderSentAt guard make the exact cadence non-critical — a missed minute
// just fires the reminder a minute later, still comfortably before the slot.
export function startReminderScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void sendDueReminders(), 60_000);
  timer.unref?.(); // don't keep the process alive on shutdown
  void sendDueReminders(); // sweep once at boot instead of waiting a minute
}
