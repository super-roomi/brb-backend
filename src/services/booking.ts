import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { notifyUser } from "../lib/notify.js";
import { localize, parseLang } from "../lib/localize.js";
import { newReservation } from "../lib/notificationMessages.js";
import { addDays, localDateToUtc, weekdayOfLocalDate } from "../lib/time.js";
import { BOOKING_HORIZON_DAYS, BOOKING_LEAD_MIN, SLOT_STEP_MIN } from "./availability.js";
import { voidPairForReservation } from "./referral.js";

export const CANCEL_CUTOFF_MIN = 120; // cancellations allowed until 2h before start

// How many times to retry a booking transaction that aborted because a
// concurrent booking touched the same rows (Serializable serialization
// failure). Bookings are low-QPS writes, so a few retries cost nothing.
const MAX_BOOKING_RETRIES = 3;

// P2034: "write conflict or deadlock, please retry" — what a Serializable
// transaction raises when it loses a race. Safe to retry.
function isRetryableTxError(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034";
}

// Postgres exclusion_violation (SQLSTATE 23P01) from the reservation-overlap
// constraint (see migration). This is the DB-level backstop firing; surface it
// as the same friendly conflict the app already knows how to handle.
function isOverlapExclusionViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("no_barber_overlap") || msg.includes("23P01");
}

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

  // Capacity check and insert must be atomic against concurrent bookings for
  // the same slot. Under Postgres' default READ COMMITTED, two requests can
  // both read "slot free" and both insert; Serializable isolation makes one of
  // them abort with a serialization failure instead, which we retry. The
  // exclusion constraint in the migration is the DB-level backstop if this ever
  // slips (e.g. a path that forgets the isolation level).
  for (let attempt = 0; ; attempt++) {
    try {
      const reservation = await runBookingTx({
        userId,
        shopId,
        serviceId,
        startsAt,
        endsAt,
        useBarbers,
        eligible,
        chairCount: shop.chairCount,
        bufferMin: shop.bufferMin,
        servicePrice: service.price,
        specificBarber: barberId,
      });
      // Let the assigned barber know a request/booking just came in.
      void notifyBarberOfNewReservation(reservation);
      return reservation;
    } catch (e) {
      if (isRetryableTxError(e)) {
        if (attempt < MAX_BOOKING_RETRIES) continue;
        // Out of retries. This is contention, not a server fault: several
        // people are racing for the same slot and we keep losing the
        // serialization race. Reporting it as a 500 (which is what falling
        // through to `throw e` did) showed "Something went wrong" during
        // exactly the traffic spike where "that slot was taken" is both true
        // and actionable — and the app has no handler for a 500.
        logger.warn(
          { shopId, serviceId, startsAt, barberId },
          "booking gave up after repeated serialization failures",
        );
        throw ApiError.conflict("That time was just taken. Pick another slot.", "SLOT_TAKEN");
      }
      if (isOverlapExclusionViolation(e)) {
        throw ApiError.conflict("That time was just taken. Pick another slot.", "SLOT_TAKEN");
      }
      throw e;
    }
  }
}

// Notify the assigned barber (by their app account, linked via email) that a
// new reservation landed. No-op for chair-capacity shops with no barbers, or a
// barber who hasn't signed into the app yet.
async function notifyBarberOfNewReservation(r: {
  id: string;
  userId: string;
  barberId: string | null;
  status: string;
  service: { name: string; nameAr: string | null; nameCkb: string | null };
}): Promise<void> {
  if (!r.barberId) return;
  try {
    const barber = await prisma.barber.findUnique({
      where: { id: r.barberId },
      select: { email: true },
    });
    if (!barber) return;
    const [barberUser, customer] = await Promise.all([
      prisma.user.findUnique({ where: { email: barber.email }, select: { id: true, lang: true } }),
      prisma.user.findUnique({ where: { id: r.userId }, select: { name: true } }),
    ]);
    if (!barberUser) return;
    const lang = parseLang(barberUser.lang);
    const who =
      customer?.name?.trim() ||
      (lang === "ar" ? "أحد العملاء" : lang === "ckb" ? "کڕیارێک" : "A customer");
    const pending = r.status === "PENDING";
    await notifyUser({
      userId: barberUser.id,
      type: "NEW_RESERVATION",
      reservationId: r.id,
      lang,
      build: (l) =>
        newReservation(l, {
          customer: who,
          service: localize(l, r.service.name, r.service.nameAr, r.service.nameCkb),
          pending,
        }),
    });
  } catch (err) {
    logger.error({ err }, "barber new-reservation notify failed");
  }
}

// The transactional core of createReservation, isolated so the retry loop above
// can re-run it verbatim on a serialization failure.
function runBookingTx(args: {
  userId: string;
  shopId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  useBarbers: boolean;
  eligible: { id: string; autoApprove: boolean }[];
  chairCount: number;
  bufferMin: number;
  servicePrice: number;
  specificBarber?: string;
}) {
  const {
    userId,
    shopId,
    serviceId,
    startsAt,
    endsAt,
    useBarbers,
    eligible,
    chairCount,
    bufferMin,
    servicePrice,
    specificBarber,
  } = args;
  const bufMs = bufferMin * 60_000;

  return prisma.$transaction(
    async (tx) => {
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

      // Buffered overlap: a reservation conflicts when the gap between it and
      // the new booking would be smaller than the shop's grace period
      // (equivalent to inflating both intervals' ends by bufferMin). The column
      // can't be shifted in SQL through Prisma, so the query bounds move by the
      // buffer instead — same predicate.
      const overlapping = await tx.reservation.findMany({
        where: {
          shopId,
          status: { in: HOLDING_STATUSES },
          startsAt: { lt: new Date(endsAt.getTime() + bufMs) },
          endsAt: { gt: new Date(startsAt.getTime() - bufMs) },
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
            specificBarber
              ? "That barber was just booked. Pick another time or barber."
              : "That time was just taken. Pick another slot.",
            "SLOT_TAKEN",
          );
        }
        assignedBarberId = free.id;
        autoApprove = free.autoApprove;
      } else if (overlapping.length >= chairCount) {
        throw ApiError.conflict("That time was just taken. Pick another slot.", "SLOT_TAKEN");
      }

      return tx.reservation.create({
        data: {
          userId,
          shopId,
          serviceId,
          barberId: assignedBarberId,
          price: servicePrice,
          startsAt,
          endsAt,
          // PENDING waits for the barber; CONFIRMED when they auto-approve.
          status: autoApprove ? "CONFIRMED" : "PENDING",
        },
        include: reservationInclude,
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      // Bound both halves so a booking burst degrades into fast 409s instead of
      // requests piling up on a pool that never frees. maxWait caps queuing for
      // a connection; timeout caps the transaction itself.
      maxWait: 5_000,
      timeout: 10_000,
    },
  );
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
  // A double booking ("book for two") is one booking: cancelling either cut
  // cancels the whole group, so a friend is never left with a lone discounted
  // half-visit. A single booking cancels just itself.
  const groupWhere = reservation.groupId
    ? { userId, groupId: reservation.groupId, status: { in: HOLDING_STATUSES } }
    : { id: reservationId, userId, status: reservation.status };

  // Compare-and-swap on the status we validated: if a barber accepted or the
  // request was otherwise decided between our read and this write, no row
  // matches and we report the conflict instead of clobbering the new state.
  const updated = await prisma.reservation.updateMany({
    where: groupWhere,
    data: { status: "CANCELLED" },
  });
  if (updated.count === 0) {
    throw ApiError.conflict(
      "This reservation just changed. Refresh and try again.",
      "RESERVATION_CHANGED",
    );
  }
  // A cancelled booking can never complete an (old-style) referral pair, so
  // release the other person. Best-effort: promo bookkeeping must never fail a
  // cancellation.
  await voidPairForReservation(reservationId);

  return prisma.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    include: reservationInclude,
  });
}

// Admin/staff cancellation. Unlike the customer path (cancelReservation) this
// takes no userId — an admin can cancel anyone's booking — and skips the 2h
// cutoff, because the reason to cancel from the panel (a shop closes for the
// day, a customer phones in) is exactly the short-notice case the cutoff blocks
// for self-service. Everything else — the holding-status guard, the group
// cancel, the compare-and-swap, releasing a referral pair — is the same, so a
// booking cancelled by staff behaves identically to one the customer cancelled.
export async function adminCancelReservation(reservationId: string) {
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!reservation) throw ApiError.notFound("Reservation not found");
  if (!HOLDING_STATUSES.includes(reservation.status)) {
    throw ApiError.badRequest("Reservation can no longer be cancelled", "ALREADY_CANCELLED");
  }

  const groupWhere = reservation.groupId
    ? { groupId: reservation.groupId, status: { in: HOLDING_STATUSES } }
    : { id: reservationId, status: reservation.status };

  const updated = await prisma.reservation.updateMany({
    where: groupWhere,
    data: { status: "CANCELLED" },
  });
  if (updated.count === 0) {
    throw ApiError.conflict(
      "This reservation just changed. Refresh and try again.",
      "RESERVATION_CHANGED",
    );
  }

  await voidPairForReservation(reservationId);

  return prisma.reservation.findUniqueOrThrow({
    where: { id: reservationId },
    include: reservationInclude,
  });
}

export const reservationInclude = {
  shop: {
    select: {
      id: true, name: true, nameAr: true, nameCkb: true,
      address: true, imageUrl: true, utcOffsetMinutes: true,
      // Lets the app show the bring-a-friend offer on a booking card without a
      // second round trip for the shop.
      referralDiscount: true,
    },
  },
  service: {
    select: { id: true, name: true, nameAr: true, nameCkb: true, durationMin: true, price: true },
  },
  barber: { select: { id: true, name: true, nameAr: true, nameCkb: true } },
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
