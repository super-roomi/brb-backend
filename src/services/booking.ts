import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
import { addDays, localDateToUtc, weekdayOfLocalDate } from "../lib/time.js";
import { BOOKING_HORIZON_DAYS, BOOKING_LEAD_MIN, SLOT_STEP_MIN } from "./availability.js";

export const CANCEL_CUTOFF_MIN = 120; // cancellations allowed until 2h before start

export async function createReservation(input: {
  userId: string;
  shopId: string;
  serviceId: string;
  date: string; // shop-local YYYY-MM-DD
  startMinute: number;
  // Specific barber, or omitted for "any available".
  barberId?: string;
}) {
  const { userId, shopId, serviceId, date, startMinute, barberId } = input;

  const shop = await prisma.barbershop.findUnique({
    where: { id: shopId },
    include: {
      openingHours: true,
      services: { where: { id: serviceId } },
      barbers: { where: { isActive: true } },
      subscription: true,
    },
  });
  if (!shop || !isShopLive(shop)) throw ApiError.notFound("Barbershop not found");
  const service = shop.services[0];
  if (!service || !service.isActive) throw ApiError.notFound("Service not found");

  const eligible = barberId
    ? shop.barbers.filter((b) => b.id === barberId)
    : shop.barbers;
  if (barberId && eligible.length === 0) {
    throw ApiError.badRequest("Barber not available at this shop", "UNKNOWN_BARBER");
  }
  const useBarbers = shop.barbers.length > 0;

  if (startMinute % SLOT_STEP_MIN !== 0) {
    throw ApiError.badRequest(`Start time must align to ${SLOT_STEP_MIN}-minute slots`);
  }
  const hours = shop.openingHours.find((h) => h.weekday === weekdayOfLocalDate(date));
  if (
    !hours ||
    startMinute < hours.openMinute ||
    startMinute + service.durationMin > hours.closeMinute
  ) {
    throw ApiError.badRequest("Selected time is outside opening hours", "OUTSIDE_HOURS");
  }

  const startsAt = localDateToUtc(date, startMinute, shop.utcOffsetMinutes);
  const endsAt = new Date(startsAt.getTime() + service.durationMin * 60_000);
  const now = new Date();
  if (startsAt.getTime() < now.getTime() + BOOKING_LEAD_MIN * 60_000) {
    throw ApiError.badRequest(
      `Bookings need at least ${BOOKING_LEAD_MIN} minutes lead time`,
      "TOO_SOON",
    );
  }
  if (startsAt > addDays(now, BOOKING_HORIZON_DAYS)) {
    throw ApiError.badRequest(
      `Bookings open ${BOOKING_HORIZON_DAYS} days ahead`,
      "TOO_FAR",
    );
  }

  // Capacity check and insert in one transaction. SQLite serializes writers;
  // on PostgreSQL this transaction plus the (shopId, startsAt) index keeps the
  // race window negligible — belt-and-braces is an exclusion constraint (see
  // ARCHITECTURE.md).
  return prisma.$transaction(async (tx) => {
    // A customer may hold only one active booking at a time: any pending or
    // confirmed reservation that hasn't finished yet blocks a new one.
    const active = await tx.reservation.count({
      where: {
        userId,
        status: { in: HOLDING_STATUSES },
        endsAt: { gt: new Date() },
      },
    });
    if (active > 0) {
      throw ApiError.conflict(
        "You already have an active booking. Cancel it before booking again.",
        "ONE_ACTIVE_BOOKING",
      );
    }

    const overlapping = await tx.reservation.findMany({
      where: {
        shopId,
        status: { in: HOLDING_STATUSES },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
      select: { barberId: true },
    });

    let assignedBarberId: string | null = null;
    // Confirm immediately when the assigned barber has auto-approve on;
    // otherwise the request waits in their queue.
    let autoApprove = false;
    if (useBarbers) {
      // Pick the first eligible barber with no overlapping booking. For "any
      // available" eligible = all active barbers; for a specific request it is
      // that one barber, so this doubles as the capacity check.
      const taken = new Set(overlapping.map((r) => r.barberId));
      const free = eligible.find((b) => !taken.has(b.id));
      if (!free) {
        throw ApiError.conflict(
          barberId
            ? "That barber was just booked. Pick another time or barber."
            : "That time was just taken. Pick another slot.",
          "SLOT_TAKEN",
        );
      }
      assignedBarberId = free.id;
      autoApprove = free.autoApprove;
    } else if (overlapping.length >= shop.chairCount) {
      throw ApiError.conflict("That time was just taken. Pick another slot.", "SLOT_TAKEN");
    }

    return tx.reservation.create({
      data: {
        userId,
        shopId,
        serviceId,
        barberId: assignedBarberId,
        price: service.price,
        startsAt,
        endsAt,
        // PENDING waits for the barber; CONFIRMED when they auto-approve.
        status: autoApprove ? "CONFIRMED" : "PENDING",
      },
      include: reservationInclude,
    });
  });
}

// Reservations in these states occupy a chair/barber and block the slot.
export const HOLDING_STATUSES: string[] = ["PENDING", "CONFIRMED"];

export async function cancelReservation(userId: string, reservationId: string) {
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!reservation || reservation.userId !== userId) {
    throw ApiError.notFound("Reservation not found");
  }
  if (reservation.status !== "CONFIRMED" && reservation.status !== "PENDING") {
    throw ApiError.badRequest("Reservation can no longer be cancelled", "ALREADY_CANCELLED");
  }
  // The 2h cutoff only applies to confirmed appointments; a still-pending
  // request can be withdrawn any time before it starts.
  if (
    reservation.status === "CONFIRMED" &&
    reservation.startsAt.getTime() - Date.now() < CANCEL_CUTOFF_MIN * 60_000
  ) {
    throw ApiError.badRequest(
      `Cancellations close ${CANCEL_CUTOFF_MIN / 60} hours before the appointment`,
      "CANCEL_CUTOFF",
    );
  }
  return prisma.reservation.update({
    where: { id: reservationId },
    data: { status: "CANCELLED" },
    include: reservationInclude,
  });
}

export const reservationInclude = {
  shop: { select: { id: true, name: true, address: true, imageUrl: true, utcOffsetMinutes: true } },
  service: { select: { id: true, name: true, durationMin: true, price: true } },
  barber: { select: { id: true, name: true } },
} as const;

// A shop is live in the app when the admin made it visible AND it has an
// unexpired, non-cancelled subscription.
export function isShopLive(shop: {
  isVisible: boolean;
  subscription: { status: string; currentPeriodEnd: Date } | null;
}): boolean {
  return (
    shop.isVisible &&
    !!shop.subscription &&
    shop.subscription.status === "ACTIVE" &&
    shop.subscription.currentPeriodEnd > new Date()
  );
}

// Function, not const: the date must be evaluated per request.
export function liveShopWhere() {
  return {
    isVisible: true,
    subscription: { is: { status: "ACTIVE", currentPeriodEnd: { gt: new Date() } } },
  };
}
