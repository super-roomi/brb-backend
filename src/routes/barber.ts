import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
import { requireUser } from "../middleware/auth.js";

export const barberRouter = Router();
barberRouter.use(requireUser);

// A barber is a customer (User) whose phone also exists in the Barber table.
// No separate login: they sign in with phone+OTP like anyone else, and these
// endpoints unlock when their phone matches a barber record.
async function barberForRequest(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.unauthorized();
  return prisma.barber.findUnique({
    where: { phone: user.phone },
    include: { shop: { select: { id: true, name: true } } },
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
  res.json({
    isBarber: true,
    barber: { id: barber.id, name: barber.name, shop: barber.shop },
  });
});

barberRouter.get("/stats", async (req, res) => {
  const barber = await barberForRequest(req.auth!.userId);
  if (!barber) throw ApiError.forbidden("Not registered as a barber", "NOT_A_BARBER");

  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);

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
        startsAt: { gte: startOfDay },
      },
    }),
    prisma.reservation.count({
      where: { barberId: barber.id, status: "CONFIRMED", startsAt: { gte: now } },
    }),
    prisma.reservation.findMany({
      where: { barberId: barber.id },
      include: {
        service: { select: { name: true } },
        user: { select: { name: true } },
      },
      orderBy: { startsAt: "desc" },
      take: 20,
    }),
  ]);

  res.json({
    barber: { id: barber.id, name: barber.name, shop: barber.shop },
    stats: {
      totalCuts: completedAgg._count,
      totalEarnings: completedAgg._sum.price ?? 0,
      todayBookings: todayCount,
      upcomingBookings: upcomingCount,
    },
    recent: recent.map((r) => ({
      id: r.id,
      serviceName: r.service.name,
      customerName: r.user.name ?? "Customer",
      price: r.price,
      startsAt: r.startsAt.toISOString(),
      status: r.status === "CONFIRMED" && r.endsAt < now ? "COMPLETED" : r.status,
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
      service: { select: { name: true, durationMin: true } },
      user: { select: { name: true, phone: true } },
      shop: { select: { utcOffsetMinutes: true } },
    },
    orderBy: { startsAt: "asc" },
  });

  res.json({
    requests: requests.map((r) => ({
      id: r.id,
      serviceName: r.service.name,
      durationMin: r.service.durationMin,
      customerName: r.user.name ?? r.user.phone,
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

  const rows = await prisma.reservation.findMany({
    where: { barberId: barber.id, status: { in: ["PENDING", "CONFIRMED"] } },
    include: { user: { select: { id: true, name: true, phone: true } } },
    orderBy: { startsAt: "desc" },
    take: 200,
  });

  const now = new Date();
  const byCustomer = new Map<
    string,
    { name: string; phone: string; visits: number; lastVisit: string; spent: number }
  >();
  for (const r of rows) {
    const key = r.user.id;
    const done = r.status === "CONFIRMED" && r.endsAt < now;
    const existing = byCustomer.get(key);
    if (existing) {
      if (done) {
        existing.visits += 1;
        existing.spent += r.price;
      }
    } else {
      byCustomer.set(key, {
        name: r.user.name ?? r.user.phone,
        phone: r.user.phone,
        visits: done ? 1 : 0,
        lastVisit: r.startsAt.toISOString(),
        spent: done ? r.price : 0,
      });
    }
  }

  res.json({ customers: [...byCustomer.values()] });
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

  await prisma.$transaction([
    prisma.reservation.update({ where: { id: reservationId }, data: { status } }),
    prisma.notification.create({
      data: {
        userId: reservation.userId,
        type: accepted ? "BOOKING_ACCEPTED" : "BOOKING_DECLINED",
        title: accepted ? "Booking confirmed" : "Booking declined",
        body: accepted
          ? `${barber.name} confirmed your ${reservation.service.name} at ${reservation.shop.name}.`
          : `${barber.name} could not take your ${reservation.service.name} at ${reservation.shop.name}. Please pick another time.`,
        reservationId: reservation.id,
      },
    }),
  ]);

  return { id: reservation.id, status };
}
