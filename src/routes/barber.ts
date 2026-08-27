import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
import { requireUser } from "../middleware/auth.js";
import { validate, parsed } from "../middleware/validate.js";
import { localDayRangeUtc } from "../lib/time.js";
import { parseLang, localize, type Lang } from "../lib/localize.js";
import { sendPushToUser } from "../lib/push.js";
import { bookingConfirmed, bookingDeclined } from "../lib/notificationMessages.js";
import { mintBarberToken, voidPairForReservation, QR_TTL_MS } from "../services/referral.js";

export const barberRouter = Router();
barberRouter.use(requireUser);

// Shared reservation-card fields for the barber's day view and request queue.
// Both add their own extras (a `done` flag, the shop offset), so the common
// shape — including the discounted price and the guest/customer-name fallback —
// lives here and can't drift between the two lists.
function barberReservationCard(
  r: {
    id: string;
    service: { name: string; nameAr: string | null; nameCkb: string | null; durationMin: number };
    guestName: string | null;
    user: { name: string | null; email: string };
    price: number;
    discountAmount: number;
    groupId: string | null;
    startsAt: Date;
  },
  lang: Lang,
) {
  return {
    id: r.id,
    serviceName: localize(lang, r.service.name, r.service.nameAr, r.service.nameCkb),
    durationMin: r.service.durationMin,
    // On a "book for two" double, the friend's cut carries a guest name; the
    // initiator's own cut shows their account name like any single booking.
    customerName: r.guestName ?? r.user.name ?? r.user.email,
    // What to charge: the referral discount is already netted off.
    price: r.price - r.discountAmount,
    discountAmount: r.discountAmount,
    // Lets the barber see at a glance this is one half of a discounted double.
    isDouble: r.groupId !== null,
    startsAt: r.startsAt.toISOString(),
  };
}

// A barber is a customer (User) whose email also exists in the Barber table.
// No separate login: they sign in with Google like anyone else, and these
// endpoints unlock when their email matches a barber record.
async function barberForRequest(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.unauthorized();
  return prisma.barber.findUnique({
    where: { email: user.email },
    // utcOffsetMinutes rides along because every "today" view needs the shop's
    // local day. Fetching it here saves /stats and /today a second round trip
    // each — they used to re-query Barbershop for this one column.
    include: {
      shop: {
        select: {
          id: true,
          name: true,
          nameAr: true,
          nameCkb: true,
          utcOffsetMinutes: true,
          referralDiscount: true,
        },
      },
    },
  });
}

// Cheap probe the app calls after login to decide whether to show the
// barber dashboard. Never 403s — returns isBarber:false for normal customers.
barberRouter.get("/me", async (req, res) => {
  const barber = await barberForRequest(req.auth!.userId);
  if (!barber || !barber.isActive) {
    res.json({ isBarber: false });
    return;
  }
  const lang = parseLang(req.query.lang);
  res.json({
    isBarber: true,
    barber: {
      id: barber.id,
      name: localize(lang, barber.name, barber.nameAr, barber.nameCkb),
      shop: {
        id: barber.shop.id,
        name: localize(lang, barber.shop.name, barber.shop.nameAr, barber.shop.nameCkb),
      },
      autoApprove: barber.autoApprove,
      // 0 when this shop isn't running bring-a-friend, so the app can hide the
      // check-in QR rather than offering a button that only errors.
      referralDiscount: barber.shop.referralDiscount,
    },
  });
});

// Toggle auto-approve. Turning it ON also confirms every request already
// waiting in the queue (and notifies those customers).
const autoApproveSchema = z.object({ enabled: z.boolean() });

barberRouter.patch("/auto-approve", validate(autoApproveSchema), async (req, res) => {
  const barber = await barberForRequest(req.auth!.userId);
  if (!barber) throw ApiError.forbidden("Not registered as a barber", "NOT_A_BARBER");
  const { enabled } = parsed<z.infer<typeof autoApproveSchema>>(req);

  await prisma.barber.update({ where: { id: barber.id }, data: { autoApprove: enabled } });

  let approved = 0;
  if (enabled) {
    const pending = await prisma.reservation.findMany({
      where: { barberId: barber.id, status: "PENDING", endsAt: { gte: new Date() } },
      include: {
        shop: { select: { name: true, nameAr: true, nameCkb: true } },
        service: { select: { name: true, nameAr: true, nameCkb: true } },
        user: { select: { lang: true } },
      },
    });
    if (pending.length > 0) {
      const ids = pending.map((r) => r.id);
      // Each customer may read a different language, so build the copy per row.
      const msgs = pending.map((r) => {
        const lang = parseLang(r.user.lang);
        return bookingConfirmed(lang, {
          barber: localize(lang, barber.name, barber.nameAr, barber.nameCkb),
          service: localize(lang, r.service.name, r.service.nameAr, r.service.nameCkb),
          shop: localize(lang, r.shop.name, r.shop.nameAr, r.shop.nameCkb),
        });
      });
      // One transaction instead of N: confirm the whole backlog and write all
      // notifications together. The status:"PENDING" guard means any request
      // cancelled since the fetch is left alone.
      await prisma.$transaction([
        prisma.reservation.updateMany({
          where: { id: { in: ids }, status: "PENDING" },
          data: { status: "CONFIRMED" },
        }),
        prisma.notification.createMany({
          data: pending.map((r, i) => ({
            userId: r.userId,
            type: "BOOKING_ACCEPTED",
            title: msgs[i].title,
            body: msgs[i].body,
            reservationId: r.id,
          })),
        }),
      ]);
      // Real push per confirmed request (no-op if FCM unconfigured).
      for (let i = 0; i < pending.length; i++) {
        void sendPushToUser(pending[i].userId, {
          title: msgs[i].title,
          body: msgs[i].body,
          data: { type: "BOOKING_ACCEPTED", reservationId: pending[i].id },
        });
      }
    }
    approved = pending.length;
  }
  res.json({ autoApprove: enabled, approved });
});

barberRouter.get("/stats", async (req, res) => {
  const barber = await barberForRequest(req.auth!.userId);
  if (!barber) throw ApiError.forbidden("Not registered as a barber", "NOT_A_BARBER");

  const now = new Date();
  // "Today" means the shop's local calendar day (matches /barber/today), not
  // UTC's — otherwise, between 00:00 and 03:00 local (UTC+3), this tab and the
  // Today tab disagree about which day it is.
  const { dayStart, dayEnd } = localDayRangeUtc(now, barber.shop.utcOffsetMinutes);

  const [completedAgg, todayCount, upcomingCount, recent] = await Promise.all([
    // Earnings + lifetime cut count from completed (past, confirmed) bookings.
    prisma.reservation.aggregate({
      where: { barberId: barber.id, status: "CONFIRMED", endsAt: { lt: now } },
      // The barber funds the bring-a-friend promo, so earnings are the sum of
      // what was actually payable: price - discountAmount.
      _sum: { price: true, discountAmount: true },
      _count: true,
    }),
    prisma.reservation.count({
      where: {
        barberId: barber.id,
        status: "CONFIRMED",
        startsAt: { gte: dayStart, lt: dayEnd },
      },
    }),
    prisma.reservation.count({
      where: { barberId: barber.id, status: "CONFIRMED", startsAt: { gte: now } },
    }),
    prisma.reservation.findMany({
      where: { barberId: barber.id },
      include: {
        service: { select: { name: true, nameAr: true, nameCkb: true } },
        user: { select: { name: true } },
      },
      orderBy: { startsAt: "desc" },
      take: 20,
    }),
  ]);

  const lang = parseLang(req.query.lang);
  res.json({
    barber: {
      id: barber.id,
      name: localize(lang, barber.name, barber.nameAr, barber.nameCkb),
      shop: {
        id: barber.shop.id,
        name: localize(lang, barber.shop.name, barber.shop.nameAr, barber.shop.nameCkb),
      },
    },
    stats: {
      // archived* carries the appointments whose Reservation rows were removed
      // when a customer deleted their account, so a deletion no longer rewrites
      // this barber's lifetime totals. See DELETE /api/auth/me.
      totalCuts: completedAgg._count + barber.archivedCuts,
      totalEarnings:
        (completedAgg._sum.price ?? 0) -
        (completedAgg._sum.discountAmount ?? 0) +
        barber.archivedEarnings,
      todayBookings: todayCount,
      upcomingBookings: upcomingCount,
    },
    recent: recent.map((r) => ({
      id: r.id,
      serviceName: localize(lang, r.service.name, r.service.nameAr, r.service.nameCkb),
      customerName: r.user.name ?? "Customer",
      price: r.price - r.discountAmount,
      startsAt: r.startsAt.toISOString(),
      status: r.status === "CONFIRMED" && r.endsAt < now ? "COMPLETED" : r.status,
    })),
  });
});

// Today's confirmed appointments for this barber (the barber's main view),
// soonest first. "Today" is the shop's local calendar day.
barberRouter.get("/today", async (req, res) => {
  const barber = await barberForRequest(req.auth!.userId);
  if (!barber) throw ApiError.forbidden("Not registered as a barber", "NOT_A_BARBER");

  const offset = barber.shop.utcOffsetMinutes;
  const now = new Date();
  const { dayStart, dayEnd } = localDayRangeUtc(now, offset);

  const appts = await prisma.reservation.findMany({
    where: {
      barberId: barber.id,
      status: "CONFIRMED",
      startsAt: { gte: dayStart, lt: dayEnd },
    },
    include: {
      service: { select: { name: true, nameAr: true, nameCkb: true, durationMin: true } },
      user: { select: { name: true, email: true } },
    },
    orderBy: { startsAt: "asc" },
  });

  const lang = parseLang(req.query.lang);
  res.json({
    utcOffsetMinutes: offset,
    appointments: appts.map((r) => ({
      ...barberReservationCard(r, lang),
      done: r.endsAt < now,
    })),
  });
});

// Pending requests waiting on this barber's decision (soonest first).
barberRouter.get("/requests", async (req, res) => {
  const barber = await barberForRequest(req.auth!.userId);
  if (!barber) throw ApiError.forbidden("Not registered as a barber", "NOT_A_BARBER");

  const requests = await prisma.reservation.findMany({
    where: { barberId: barber.id, status: "PENDING", endsAt: { gte: new Date() } },
    include: {
      service: { select: { name: true, nameAr: true, nameCkb: true, durationMin: true } },
      user: { select: { name: true, email: true } },
      shop: { select: { utcOffsetMinutes: true } },
    },
    orderBy: { startsAt: "asc" },
  });

  const lang = parseLang(req.query.lang);
  res.json({
    requests: requests.map((r) => ({
      ...barberReservationCard(r, lang),
      utcOffsetMinutes: r.shop.utcOffsetMinutes,
    })),
  });
});

// Distinct customers this barber has served, most recent first, with a
// lifetime visit count.
barberRouter.get("/customers", async (req, res) => {
  const barber = await barberForRequest(req.auth!.userId);
  if (!barber) throw ApiError.forbidden("Not registered as a barber", "NOT_A_BARBER");

  const now = new Date();
  // Aggregate in the database, not by scanning a capped page of reservations
  // (the old take:200 silently stopped counting a busy barber's history after
  // ~a month). Two grouped queries: recency across all live bookings, and
  // completed-visit counts/spend.
  const [recency, completed] = await Promise.all([
    prisma.reservation.groupBy({
      by: ["userId"],
      where: { barberId: barber.id, status: { in: ["PENDING", "CONFIRMED"] } },
      _max: { startsAt: true },
    }),
    prisma.reservation.groupBy({
      by: ["userId"],
      where: { barberId: barber.id, status: "CONFIRMED", endsAt: { lt: now } },
      _count: { _all: true },
      _sum: { price: true, discountAmount: true },
    }),
  ]);

  const completedByUser = new Map(completed.map((c) => [c.userId, c]));
  // Most recently seen customers first; cap the returned list, not the scan.
  const top = recency
    .sort(
      (a, b) => (b._max.startsAt?.getTime() ?? 0) - (a._max.startsAt?.getTime() ?? 0),
    )
    .slice(0, 200);

  const users = await prisma.user.findMany({
    where: { id: { in: top.map((r) => r.userId) } },
    select: { id: true, name: true, email: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  const customers = top.map((r) => {
    const u = userById.get(r.userId);
    const c = completedByUser.get(r.userId);
    return {
      name: u?.name ?? u?.email ?? "Customer",
      email: u?.email ?? "",
      visits: c?._count._all ?? 0,
      lastVisit: (r._max.startsAt ?? now).toISOString(),
      spent: (c?._sum.price ?? 0) - (c?._sum.discountAmount ?? 0),
    };
  });

  res.json({ customers });
});

// The QR the barber shows at the chair for "bring a friend" check-in.
//
// Short-lived and minted per request, so the app must keep asking while the
// screen is open. That is the point: a token that outlived the visit could be
// screenshotted and sent to a friend at home, and "both are present" would stop
// meaning anything. Bound to this barber's shop via their own session.
barberRouter.get("/referral-token", async (req, res) => {
  const barber = await barberForRequest(req.auth!.userId);
  if (!barber) throw ApiError.forbidden("Not registered as a barber", "NOT_A_BARBER");
  if (barber.shop.referralDiscount <= 0) {
    throw ApiError.badRequest(
      "This barbershop is not running the bring-a-friend offer",
      "REFERRAL_NOT_AVAILABLE",
    );
  }
  const { token, expiresAt } = await mintBarberToken(barber.id, barber.shopId);
  res.json({
    token,
    expiresAt: expiresAt.toISOString(),
    ttlMs: QR_TTL_MS,
    discountAmount: barber.shop.referralDiscount,
  });
});

barberRouter.post("/reservations/:id/accept", async (req, res) => {
  const reservation = await decideReservation(req.auth!.userId, req.params.id, "accept");
  res.json({ reservation });
});

barberRouter.post("/reservations/:id/decline", async (req, res) => {
  const reservation = await decideReservation(req.auth!.userId, req.params.id, "decline");
  res.json({ reservation });
});

// Accept/decline a pending request. Only the assigned barber may decide, only
// while it is still PENDING. Writes the status and a customer notification in
// one transaction.
async function decideReservation(
  userId: string,
  reservationId: string,
  action: "accept" | "decline",
) {
  const barber = await barberForRequest(userId);
  if (!barber) throw ApiError.forbidden("Not registered as a barber", "NOT_A_BARBER");

  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: {
      shop: { select: { name: true, nameAr: true, nameCkb: true } },
      service: { select: { name: true, nameAr: true, nameCkb: true } },
    },
  });
  if (!reservation || reservation.barberId !== barber.id) {
    throw ApiError.notFound("Request not found");
  }
  if (reservation.status !== "PENDING") {
    throw ApiError.badRequest("This request was already handled", "ALREADY_DECIDED");
  }

  const accepted = action === "accept";
  const status = accepted ? "CONFIRMED" : "DECLINED";

  // The customer reads this notification, so localize to their language.
  const customer = await prisma.user.findUnique({
    where: { id: reservation.userId },
    select: { lang: true },
  });
  const lang = parseLang(customer?.lang);
  const names = {
    barber: localize(lang, barber.name, barber.nameAr, barber.nameCkb),
    service: localize(lang, reservation.service.name, reservation.service.nameAr, reservation.service.nameCkb),
    shop: localize(lang, reservation.shop.name, reservation.shop.nameAr, reservation.shop.nameCkb),
  };
  const { title, body } = accepted ? bookingConfirmed(lang, names) : bookingDeclined(lang, names);

  // Compare-and-swap inside the transaction: the decision only lands if the
  // reservation is still PENDING. If the customer cancelled between our read
  // and here, updateMany matches zero rows — we abort rather than resurrect a
  // cancelled booking and fire a bogus notification.
  await prisma.$transaction(async (tx) => {
    const updated = await tx.reservation.updateMany({
      where: { id: reservationId, barberId: barber.id, status: "PENDING" },
      data: { status },
    });
    if (updated.count === 0) {
      throw ApiError.badRequest("This request was already handled", "ALREADY_DECIDED");
    }
    await tx.notification.create({
      data: {
        userId: reservation.userId,
        type: accepted ? "BOOKING_ACCEPTED" : "BOOKING_DECLINED",
        title,
        body,
        reservationId: reservation.id,
      },
    });
  });

  // A declined booking can't complete its referral either.
  if (!accepted) void voidPairForReservation(reservationId);

  // Real push on top of the in-app record (no-op if FCM unconfigured).
  void sendPushToUser(reservation.userId, {
    title,
    body,
    data: {
      type: accepted ? "BOOKING_ACCEPTED" : "BOOKING_DECLINED",
      reservationId: reservation.id,
    },
  });

  return { id: reservation.id, status };
}
