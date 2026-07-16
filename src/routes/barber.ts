import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
import { requireUser } from "../middleware/auth.js";
import { validate, parsed } from "../middleware/validate.js";
import { localDayRangeUtc } from "../lib/time.js";
import { parseLang, localize } from "../lib/localize.js";
import { sendPushToUser } from "../lib/push.js";

export const barberRouter = Router();
barberRouter.use(requireUser);

// A barber is a customer (User) whose email also exists in the Barber table.
// No separate login: they sign in with Google like anyone else, and these
// endpoints unlock when their email matches a barber record.
async function barberForRequest(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.unauthorized();
  return prisma.barber.findUnique({
    where: { email: user.email },
    include: { shop: { select: { id: true, name: true, nameAr: true, nameCkb: true } } },
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
      include: { shop: { select: { name: true } }, service: { select: { name: true } } },
    });
    if (pending.length > 0) {
      const ids = pending.map((r) => r.id);
      // One transaction instead of N: confirm the whole backlog and write all
      // notifications together. The status:"PENDING" guard means any request
      // cancelled since the fetch is left alone.
      await prisma.$transaction([
        prisma.reservation.updateMany({
          where: { id: { in: ids }, status: "PENDING" },
          data: { status: "CONFIRMED" },
        }),
        prisma.notification.createMany({
          data: pending.map((r) => ({
            userId: r.userId,
            type: "BOOKING_ACCEPTED",
            title: "Booking confirmed",
            body: `${barber.name} confirmed your ${r.service.name} at ${r.shop.name}.`,
            reservationId: r.id,
          })),
        }),
      ]);
      // Real push per confirmed request (no-op if FCM unconfigured).
      for (const r of pending) {
        void sendPushToUser(r.userId, {
          title: "Booking confirmed",
          body: `${barber.name} confirmed your ${r.service.name} at ${r.shop.name}.`,
          data: { type: "BOOKING_ACCEPTED", reservationId: r.id },
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
  const shop = await prisma.barbershop.findUnique({
    where: { id: barber.shopId },
    select: { utcOffsetMinutes: true },
  });
  const { dayStart, dayEnd } = localDayRangeUtc(now, shop?.utcOffsetMinutes ?? 180);

  const [completedAgg, todayCount, upcomingCount, recent] = await Promise.all([
    // Earnings + lifetime cut count from completed (past, confirmed) bookings.
    prisma.reservation.aggregate({
      where: { barberId: barber.id, status: "CONFIRMED", endsAt: { lt: now } },
      _sum: { price: true },
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
      totalCuts: completedAgg._count,
      totalEarnings: completedAgg._sum.price ?? 0,
      todayBookings: todayCount,
      upcomingBookings: upcomingCount,
    },
    recent: recent.map((r) => ({
      id: r.id,
      serviceName: localize(lang, r.service.name, r.service.nameAr, r.service.nameCkb),
      customerName: r.user.name ?? "Customer",
      price: r.price,
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

  const shop = await prisma.barbershop.findUnique({
    where: { id: barber.shopId },
    select: { utcOffsetMinutes: true },
  });
  const offset = shop?.utcOffsetMinutes ?? 180;
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
      id: r.id,
      serviceName: localize(lang, r.service.name, r.service.nameAr, r.service.nameCkb),
      durationMin: r.service.durationMin,
      customerName: r.user.name ?? r.user.email,
      price: r.price,
      startsAt: r.startsAt.toISOString(),
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
      id: r.id,
      serviceName: localize(lang, r.service.name, r.service.nameAr, r.service.nameCkb),
      durationMin: r.service.durationMin,
      customerName: r.user.name ?? r.user.email,
      price: r.price,
      startsAt: r.startsAt.toISOString(),
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
      _sum: { price: true },
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
      spent: c?._sum.price ?? 0,
    };
  });

  res.json({ customers });
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
    include: { shop: { select: { name: true } }, service: { select: { name: true } } },
  });
  if (!reservation || reservation.barberId !== barber.id) {
    throw ApiError.notFound("Request not found");
  }
  if (reservation.status !== "PENDING") {
    throw ApiError.badRequest("This request was already handled", "ALREADY_DECIDED");
  }

  const accepted = action === "accept";
  const status = accepted ? "CONFIRMED" : "DECLINED";
  const title = accepted ? "Booking confirmed" : "Booking declined";
  const body = accepted
    ? `${barber.name} confirmed your ${reservation.service.name} at ${reservation.shop.name}.`
    : `${barber.name} could not take your ${reservation.service.name} at ${reservation.shop.name}. Please pick another time.`;

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
