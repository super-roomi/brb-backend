import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
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
    },
  });
  if (!shop) throw ApiError.notFound("Barbershop not found");
  const service = shop.services[0];
  if (!service || !service.isActive) throw ApiError.notFound("Service not found");

  const eligible = barberId
    ? shop.barbers.filter((b) => b.id === barberId)
    : shop.barbers;
  if (barberId && eligible.length === 0) throw ApiError.notFound("Barber not found");

  const hours = shop.openingHours.find((h) => h.weekday === weekdayOfLocalDate(date));
  if (!hours) return []; // closed that day

  const dayStart = localDateToUtc(date, 0, shop.utcOffsetMinutes);
  const dayEnd = localDateToUtc(date, 24 * 60, shop.utcOffsetMinutes);
  const existing = await prisma.reservation.findMany({
    where: {
      shopId,
      // Pending requests hold the slot too, so they can't be double-booked.
      status: { in: ["PENDING", "CONFIRMED"] },
      startsAt: { lt: dayEnd },
      endsAt: { gt: dayStart },
    },
    select: { startsAt: true, endsAt: true, barberId: true },
  });

  const earliest = Date.now() + BOOKING_LEAD_MIN * 60_000;
  const useBarbers = eligible.length > 0;
  const slots: Slot[] = [];

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
        (b) =>
          !existing.some(
            (r) => r.barberId === b.id && r.startsAt < end && r.endsAt > start,
          ),
      );
      if (someoneFree) slots.push({ startMinute: m, startsAt: start.toISOString() });
    } else {
      const overlapping = existing.filter(
        (r) => r.startsAt < end && r.endsAt > start,
      ).length;
      if (overlapping < shop.chairCount) {
        slots.push({ startMinute: m, startsAt: start.toISOString() });
      }
    }
  }
  return slots;
}
