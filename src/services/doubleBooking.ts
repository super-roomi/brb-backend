import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { notifyUser } from "../lib/notify.js";
import { localize, parseLang } from "../lib/localize.js";
import { newReservation } from "../lib/notificationMessages.js";
import { addDays, localDateToUtc, weekdayOfLocalDate } from "../lib/time.js";
import { BOOKING_HORIZON_DAYS, BOOKING_LEAD_MIN, SLOT_STEP_MIN } from "./availability.js";
import {
  HOLDING_STATUSES,
  isShopLive,
  reservationInclude,
} from "./booking.js";

// "Book for two" — the same-visit bring-a-friend booking.
//
// One person books TWO cuts at once: their own and a friend's. The two cuts run
// back-to-back with the same barber, so the pair is one continuous visit, and
// both carry the shop's referral discount. Because the initiator commits to both
// up front, the discount is settled at booking time — there is no "one paid
// before the other showed up" race that the earlier scan-based design had.
//
// The two reservations share a groupId and are created, shown, and cancelled as
// one unit.

// Retry a serialization failure a few times, same as single booking.
const MAX_RETRIES = 3;

function isRetryableTxError(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034";
}
function isOverlapExclusionViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("no_barber_overlap") || msg.includes("23P01");
}

type ShopForDouble = Awaited<ReturnType<typeof loadShop>>;

async function loadShop(shopId: string, serviceIds: string[]) {
  return prisma.barbershop.findUnique({
    where: { id: shopId },
    include: {
      openingHours: true,
      services: { where: { id: { in: serviceIds } } },
      barbers: { where: { isActive: true } },
      subscription: true,
    },
  });
}

// Resolve the two chosen services (they may be the same one, e.g. both get the
// standard cut) and return them in the requested order.
function resolveServices(
  shop: NonNullable<ShopForDouble>,
  firstServiceId: string,
  secondServiceId: string,
) {
  const byId = new Map(shop.services.map((s) => [s.id, s]));
  const first = byId.get(firstServiceId);
  const second = byId.get(secondServiceId);
  if (!first || !first.isActive || !second || !second.isActive) {
    throw ApiError.notFound("Service not found");
  }
  return { first, second };
}

/**
 * Free start times for a double booking on [date].
 *
 * A slot only qualifies when one barber (or chair) is free for the WHOLE
 * back-to-back block, first cut then second. That is exactly what stops a double
 * being offered a time whose second cut would collide with a later booking — the
 * "a single at 6pm blocks a double starting 5:30" case.
 */
export async function computeDoubleSlots(
  shopId: string,
  date: string,
  firstServiceId: string,
  secondServiceId: string,
) {
  const shop = await loadShop(shopId, [firstServiceId, secondServiceId]);
  if (!shop || !isShopLive(shop)) throw ApiError.notFound("Barbershop not found");
  if (shop.referralDiscount <= 0) {
    throw ApiError.badRequest(
      "This barbershop is not running the bring-a-friend offer",
      "REFERRAL_NOT_AVAILABLE",
    );
  }
  const { first, second } = resolveServices(shop, firstServiceId, secondServiceId);
  const blockMinutes = first.durationMin + second.durationMin;

  const hours = shop.openingHours.find((h) => h.weekday === weekdayOfLocalDate(date));
  if (!hours) return { slots: [], blockMinutes };

  const bufMs = shop.bufferMin * 60_000;
  const dayStart = localDateToUtc(date, 0, shop.utcOffsetMinutes);
  const dayEnd = localDateToUtc(date, 24 * 60, shop.utcOffsetMinutes);
  const existing = await prisma.reservation.findMany({
    where: {
      shopId,
      status: { in: HOLDING_STATUSES },
      startsAt: { lt: new Date(dayEnd.getTime() + bufMs) },
      endsAt: { gt: new Date(dayStart.getTime() - bufMs) },
    },
    select: { startsAt: true, endsAt: true, barberId: true },
  });

  const earliest = Date.now() + BOOKING_LEAD_MIN * 60_000;
  const eligible = shop.barbers;
  const useBarbers = eligible.length > 0;
  const slots: { startMinute: number; startsAt: string }[] = [];

  // The whole double block is treated as one interval; buffer applies at its
  // outer edges against OTHER bookings, never between the two cuts (same party).
  const conflicts = (r: { startsAt: Date; endsAt: Date }, start: Date, end: Date) =>
    r.startsAt.getTime() < end.getTime() + bufMs &&
    r.endsAt.getTime() + bufMs > start.getTime();

  for (let m = hours.openMinute; m + blockMinutes <= hours.closeMinute; m += SLOT_STEP_MIN) {
    const start = localDateToUtc(date, m, shop.utcOffsetMinutes);
    if (start.getTime() < earliest) continue;
    const end = new Date(start.getTime() + blockMinutes * 60_000);

    if (useBarbers) {
      const someoneFree = eligible.some(
        (b) => !existing.some((r) => r.barberId === b.id && conflicts(r, start, end)),
      );
      if (someoneFree) slots.push({ startMinute: m, startsAt: start.toISOString() });
    } else if (existing.filter((r) => conflicts(r, start, end)).length < shop.chairCount) {
      slots.push({ startMinute: m, startsAt: start.toISOString() });
    }
  }
  return { slots, blockMinutes };
}

export interface DoubleBookingInput {
  userId: string;
  shopId: string;
  date: string;
  startMinute: number;
  firstServiceId: string;
  secondServiceId: string;
  guestName?: string;
  // Optional: pin the whole double to one specific barber.
  barberId?: string;
}

/**
 * Create a double booking: two back-to-back reservations sharing a groupId,
 * both discounted. Returns both cuts.
 */
export async function createDoubleBooking(input: DoubleBookingInput) {
  const shop = await loadShop(input.shopId, [input.firstServiceId, input.secondServiceId]);
  if (!shop || !isShopLive(shop)) throw ApiError.notFound("Barbershop not found");
  if (shop.referralDiscount <= 0) {
    throw ApiError.badRequest(
      "This barbershop is not running the bring-a-friend offer",
      "REFERRAL_NOT_AVAILABLE",
    );
  }
  const { first, second } = resolveServices(shop, input.firstServiceId, input.secondServiceId);

  if (input.startMinute % SLOT_STEP_MIN !== 0) {
    throw ApiError.badRequest(`Start time must align to ${SLOT_STEP_MIN}-minute slots`);
  }
  const blockMinutes = first.durationMin + second.durationMin;
  const hours = shop.openingHours.find((h) => h.weekday === weekdayOfLocalDate(input.date));
  if (!hours || input.startMinute < hours.openMinute || input.startMinute + blockMinutes > hours.closeMinute) {
    throw ApiError.badRequest("Selected time is outside opening hours", "OUTSIDE_HOURS");
  }

  const firstStart = localDateToUtc(input.date, input.startMinute, shop.utcOffsetMinutes);
  const firstEnd = new Date(firstStart.getTime() + first.durationMin * 60_000);
  // Second cut begins the instant the first ends — one continuous visit, no
  // buffer between the two (they are the same party).
  const secondStart = firstEnd;
  const secondEnd = new Date(secondStart.getTime() + second.durationMin * 60_000);

  const now = new Date();
  if (firstStart.getTime() < now.getTime() + BOOKING_LEAD_MIN * 60_000) {
    throw ApiError.badRequest(`Bookings need at least ${BOOKING_LEAD_MIN} minutes lead time`, "TOO_SOON");
  }
  if (firstStart > addDays(now, BOOKING_HORIZON_DAYS)) {
    throw ApiError.badRequest(`Bookings open ${BOOKING_HORIZON_DAYS} days ahead`, "TOO_FAR");
  }

  const eligibleAll = input.barberId
    ? shop.barbers.filter((b) => b.id === input.barberId)
    : shop.barbers;
  if (input.barberId && eligibleAll.length === 0) {
    throw ApiError.badRequest("Barber not available at this shop", "UNKNOWN_BARBER");
  }
  const useBarbers = shop.barbers.length > 0;

  for (let attempt = 0; ; attempt++) {
    try {
      const created = await runDoubleTx({
        shop,
        firstService: first,
        secondService: second,
        firstStart,
        firstEnd,
        secondStart,
        secondEnd,
        blockStart: firstStart,
        blockEnd: secondEnd,
        useBarbers,
        eligible: eligibleAll,
        input,
      });
      void notifyBarberOfDouble(created);
      return created;
    } catch (e) {
      if (isRetryableTxError(e) && attempt < MAX_RETRIES) continue;
      if (isRetryableTxError(e) || isOverlapExclusionViolation(e)) {
        throw ApiError.conflict("That time was just taken. Pick another slot.", "SLOT_TAKEN");
      }
      throw e;
    }
  }
}

function runDoubleTx(args: {
  shop: NonNullable<ShopForDouble>;
  firstService: { id: string; price: number };
  secondService: { id: string; price: number };
  firstStart: Date;
  firstEnd: Date;
  secondStart: Date;
  secondEnd: Date;
  blockStart: Date;
  blockEnd: Date;
  useBarbers: boolean;
  eligible: { id: string; autoApprove: boolean }[];
  input: DoubleBookingInput;
}) {
  const { shop, input } = args;
  const bufMs = shop.bufferMin * 60_000;
  const discount = shop.referralDiscount;

  return prisma.$transaction(
    async (tx) => {
      // Same one-active-booking rule as a single: the double IS the user's one
      // active booking, so they must start with none.
      const active = await tx.reservation.count({
        where: { userId: input.userId, status: { in: HOLDING_STATUSES }, endsAt: { gt: new Date() } },
      });
      if (active > 0) {
        throw ApiError.conflict(
          "You already have an active booking. Cancel it before booking again.",
          "ONE_ACTIVE_BOOKING",
        );
      }

      // One barber must be free for the ENTIRE block; that is what keeps the two
      // cuts on the same barber and stops the second running into a later
      // booking. Buffer applies at the block's outer edges only.
      const overlapping = await tx.reservation.findMany({
        where: {
          shopId: shop.id,
          status: { in: HOLDING_STATUSES },
          startsAt: { lt: new Date(args.blockEnd.getTime() + bufMs) },
          endsAt: { gt: new Date(args.blockStart.getTime() - bufMs) },
        },
        select: { barberId: true },
      });

      let assignedBarberId: string | null = null;
      let autoApprove = false;
      if (args.useBarbers) {
        const taken = new Set(overlapping.map((r) => r.barberId));
        const free = args.eligible.find((b) => !taken.has(b.id));
        if (!free) {
          throw ApiError.conflict("That time was just taken. Pick another slot.", "SLOT_TAKEN");
        }
        assignedBarberId = free.id;
        autoApprove = free.autoApprove;
      } else if (overlapping.length >= shop.chairCount) {
        throw ApiError.conflict("That time was just taken. Pick another slot.", "SLOT_TAKEN");
      }

      const groupId = randomUUID();
      const status = autoApprove ? "CONFIRMED" : "PENDING";
      const base = {
        userId: input.userId,
        shopId: shop.id,
        barberId: assignedBarberId,
        groupId,
        status,
        discountAmount: discount,
      };

      // The initiator's own cut first, then the friend's cut back-to-back. Only
      // the friend's cut carries guestName, so the barber can tell whose is whose.
      await tx.reservation.create({
        data: {
          ...base,
          serviceId: args.firstService.id,
          price: args.firstService.price,
          startsAt: args.firstStart,
          endsAt: args.firstEnd,
        },
      });
      await tx.reservation.create({
        data: {
          ...base,
          serviceId: args.secondService.id,
          price: args.secondService.price,
          startsAt: args.secondStart,
          endsAt: args.secondEnd,
          guestName: input.guestName?.trim() || null,
        },
      });

      return tx.reservation.findMany({
        where: { groupId },
        include: reservationInclude,
        orderBy: { startsAt: "asc" },
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 5_000,
      timeout: 10_000,
    },
  );
}

// One notification to the barber for the whole double, not one per cut.
async function notifyBarberOfDouble(
  cuts: { barberId: string | null; userId: string; status: string; service: { name: string; nameAr: string | null; nameCkb: string | null } }[],
): Promise<void> {
  const first = cuts[0];
  if (!first?.barberId) return;
  try {
    const barber = await prisma.barber.findUnique({ where: { id: first.barberId }, select: { email: true } });
    if (!barber) return;
    const [barberUser, customer] = await Promise.all([
      prisma.user.findUnique({ where: { email: barber.email }, select: { id: true, lang: true } }),
      prisma.user.findUnique({ where: { id: first.userId }, select: { name: true } }),
    ]);
    if (!barberUser) return;
    const lang = parseLang(barberUser.lang);
    const who =
      customer?.name?.trim() ||
      (lang === "ar" ? "أحد العملاء" : lang === "ckb" ? "کڕیارێک" : "A customer");
    await notifyUser({
      userId: barberUser.id,
      type: "NEW_RESERVATION",
      reservationId: first ? undefined : undefined,
      lang,
      build: (l) =>
        newReservation(l, {
          // "+1" convention marks it as a two-person booking in the barber's feed.
          customer: `${who} (+1)`,
          service: localize(l, first.service.name, first.service.nameAr, first.service.nameCkb),
          pending: first.status === "PENDING",
        }),
    });
  } catch (err) {
    logger.error({ err }, "double-booking barber notify failed");
  }
}
