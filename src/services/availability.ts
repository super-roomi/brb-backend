import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
import { isShopLive } from "./booking.js";
import { localDateToUtc, weekdayOfLocalDate } from "../lib/time.js";

export const SLOT_STEP_MIN = 15;
export const BOOKING_LEAD_MIN = 30; // earliest bookable slot: now + 30 min
export const BOOKING_HORIZON_DAYS = 30;

export type Slot = { startMinute: number; startsAt: string };

// A slot is free when at least one eligible barber has no reservation
// overlapping [start, start+duration). When barberId is given, "eligible" is
// just that barber; otherwise it is every active barber in the shop. Shops
// with no active barbers fall back to the shop-level chairCount.
export async function computeFreeSlots(
  shopId: string,
  date: string,
  serviceId: string,
  barberId?: string,
): Promise<Slot[]> {
  const shop = await prisma.barbershop.findUnique({
    where: { id: shopId },
    include: {
      openingHours: true,
      services: { where: { id: serviceId } },
      barbers: { where: { isActive: true } },
      subscription: true,
    },
  });
  // Don't leak availability for shops that aren't live in the app.
  if (!shop || !isShopLive(shop)) throw ApiError.notFound("Barbershop not found");
  const service = shop.services[0];
  if (!service || !service.isActive) throw ApiError.notFound("Service not found");

  const eligible = barberId
    ? shop.barbers.filter((b) => b.id === barberId)
    : shop.barbers;
  if (barberId && eligible.length === 0) throw ApiError.notFound("Barber not found");

  const hours = shop.openingHours.find((h) => h.weekday === weekdayOfLocalDate(date));
  if (!hours) return []; // closed that day

  // Grace period between consecutive bookings: treat every booking as
  // occupying [startsAt, endsAt + buffer) in both directions, so a slot is
  // rejected when it would start too soon after an existing booking OR end too
  // close before one. bufferMin = 0 keeps the old back-to-back behaviour.
  const bufMs = shop.bufferMin * 60_000;

  const dayStart = localDateToUtc(date, 0, shop.utcOffsetMinutes);
  const dayEnd = localDateToUtc(date, 24 * 60, shop.utcOffsetMinutes);
  const existing = await prisma.reservation.findMany({
    where: {
      shopId,
      // Pending requests hold the slot too, so they can't be double-booked.
      status: { in: ["PENDING", "CONFIRMED"] },
      // Widened by the buffer so a booking just outside the day window can
      // still block the first/last slots of this day.
      startsAt: { lt: new Date(dayEnd.getTime() + bufMs) },
      endsAt: { gt: new Date(dayStart.getTime() - bufMs) },
    },
    select: { startsAt: true, endsAt: true, barberId: true },
  });

  const earliest = Date.now() + BOOKING_LEAD_MIN * 60_000;
  const useBarbers = eligible.length > 0;
  const slots: Slot[] = [];

  // Conflict when the gap between the two bookings would be < bufferMin.
  const conflicts = (r: { startsAt: Date; endsAt: Date }, start: Date, end: Date) =>
    r.startsAt.getTime() < end.getTime() + bufMs &&
    r.endsAt.getTime() + bufMs > start.getTime();

  for (
    let m = hours.openMinute;
    m + service.durationMin <= hours.closeMinute;
    m += SLOT_STEP_MIN
  ) {
    const start = localDateToUtc(date, m, shop.utcOffsetMinutes);
    if (start.getTime() < earliest) continue;
    const end = new Date(start.getTime() + service.durationMin * 60_000);

    if (useBarbers) {
      const someoneFree = eligible.some(
        (b) => !existing.some((r) => r.barberId === b.id && conflicts(r, start, end)),
      );
      if (someoneFree) slots.push({ startMinute: m, startsAt: start.toISOString() });
    } else {
      const overlapping = existing.filter((r) => conflicts(r, start, end)).length;
      if (overlapping < shop.chairCount) {
        slots.push({ startMinute: m, startsAt: start.toISOString() });
      }
    }
  }
  return slots;
}
