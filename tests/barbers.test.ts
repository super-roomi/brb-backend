import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { weekdayOfLocalDate } from "../src/lib/time.js";

const app = createApp();

let cityId: string;
let planId: string;
let shopId: string;
let serviceId: string;
let barberAId: string;
let barberBId: string;
let barberAPhone: string;
let custToken: string;
let cust2Token: string;
let barberAToken: string;
let barberBToken: string;

function openDate(): string {
  for (let d = 2; d <= 8; d++) {
    const s = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    if (weekdayOfLocalDate(s) !== 5) return s;
  }
  throw new Error("unreachable");
}

beforeAll(async () => {
  const city = await prisma.city.create({ data: { name: "Barbertown", slug: "barbertown" } });
  cityId = city.id;
  const plan = await prisma.plan.create({
    data: { name: "Barber Plan", monthlyPrice: 10_000, features: "", isFeaturedTier: false },
  });
  planId = plan.id;
  barberAPhone = "+9647709000001";

  const allWeek = Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    openMinute: 9 * 60,
    closeMinute: 18 * 60,
  })).filter((h) => h.weekday !== 5);

  const shop = await prisma.barbershop.create({
    data: {
      name: "Two Barber Shop",
      description: "A shop with two named barbers for tests.",
      address: "1 Barber Street",
      phone: "+9647500000010",
      cityId,
      chairCount: 5, // deliberately high: capacity must come from barbers, not chairs
      isVisible: true,
      instagramUrl: "https://instagram.com/twobarbershop",
      services: { create: [{ name: "Cut", durationMin: 30, price: 12_000 }] },
      openingHours: { create: allWeek },
      barbers: {
        create: [
          { name: "Barber A", phone: barberAPhone },
          { name: "Barber B", phone: "+9647709000002" },
        ],
      },
      subscription: {
        create: {
          planId,
          status: "ACTIVE",
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        },
      },
    },
    include: { services: true, barbers: { orderBy: { name: "asc" } } },
  });
  shopId = shop.id;
  serviceId = shop.services[0].id;
  barberAId = shop.barbers[0].id;
  barberBId = shop.barbers[1].id;

  custToken = await newUser("+9647508000001");
  cust2Token = await newUser("+9647508000002");
  // Barber logs in once with their barber phone; reused (OTP resend cooldown
  // is per-phone, so re-logging in the same test run would hit the cooldown).
  barberAToken = await newUser(barberAPhone);
  barberBToken = await newUser("+9647709000002");
});

describe("barbers in catalog", () => {
  it("exposes barbers and social links on the shop detail", async () => {
    const res = await request(app).get(`/api/shops/${shopId}`);
    expect(res.status).toBe(200);
    expect(res.body.shop.barbers).toHaveLength(2);
    expect(res.body.shop.social.instagram).toContain("instagram.com");
  });

  it("filters availability to a single barber", async () => {
    const res = await request(app)
      .get(`/api/shops/${shopId}/availability`)
      .query({ date: openDate(), serviceId, barberId: barberAId });
    expect(res.status).toBe(200);
    expect(res.body.slots.length).toBeGreaterThan(0);
  });
});

describe("per-barber capacity", () => {
  const date = openDate();

  it("books a specific barber, then blocks the same barber at that time", async () => {
    const a = await request(app)
      .post("/api/reservations")
      .set(auth(custToken))
      .send({ shopId, serviceId, date, startMinute: 600, barberId: barberAId });
    expect(a.status).toBe(201);
    expect(a.body.reservation.barber.id).toBe(barberAId);

    const clash = await request(app)
      .post("/api/reservations")
      .set(auth(cust2Token))
      .send({ shopId, serviceId, date, startMinute: 600, barberId: barberAId });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("SLOT_TAKEN");
  });

  it("still allows 'any available' at that time — the other barber is free", async () => {
    const any = await request(app)
      .post("/api/reservations")
      .set(auth(cust2Token))
      .send({ shopId, serviceId, date, startMinute: 600 });
    expect(any.status).toBe(201);
    expect(any.body.reservation.barber.id).toBe(barberBId);
  });

  it("now both barbers are taken → next booking at that slot fails", async () => {
    const third = await newUser("+9647508000003");
    const res = await request(app)
      .post("/api/reservations")
      .set(auth(third))
      .send({ shopId, serviceId, date, startMinute: 600 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SLOT_TAKEN");
  });
});

describe("barber self-service", () => {
  it("reports isBarber:false for a normal customer", async () => {
    const res = await request(app).get("/api/barber/me").set(auth(custToken));
    expect(res.status).toBe(200);
    expect(res.body.isBarber).toBe(false);
  });

  it("recognizes a barber who logs in with their barber phone", async () => {
    const me = await request(app).get("/api/barber/me").set(auth(barberAToken));
    expect(me.status).toBe(200);
    expect(me.body.isBarber).toBe(true);
    expect(me.body.barber.shop.name).toBe("Two Barber Shop");
  });

  it("returns stats with earnings from completed cuts", async () => {
    // Seed a completed (past) reservation assigned to Barber A.
    const cust = await prisma.user.findFirst({ where: { phone: "+9647508000001" } });
    await prisma.reservation.create({
      data: {
        userId: cust!.id,
        shopId,
        serviceId,
        barberId: barberAId,
        price: 12_000,
        startsAt: new Date(Date.now() - 2 * 86_400_000),
        endsAt: new Date(Date.now() - 2 * 86_400_000 + 30 * 60_000),
        status: "CONFIRMED",
      },
    });
    const res = await request(app).get("/api/barber/stats").set(auth(barberAToken));
    expect(res.status).toBe(200);
    expect(res.body.stats.totalCuts).toBeGreaterThanOrEqual(1);
    expect(res.body.stats.totalEarnings).toBeGreaterThanOrEqual(12_000);
    expect(res.body.barber.shop.name).toBe("Two Barber Shop");
  });

  it("blocks stats for non-barbers", async () => {
    const res = await request(app).get("/api/barber/stats").set(auth(cust2Token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NOT_A_BARBER");
  });
});

describe("admin: barber phone uniqueness", () => {
  let adminToken: string;
  beforeAll(async () => {
    const bcrypt = (await import("bcryptjs")).default;
    await prisma.adminUser.create({
      data: { email: "admin@barbertest.dev", name: "A", passwordHash: await bcrypt.hash("password12", 10) },
    });
    const res = await request(app)
      .post("/api/admin/login")
      .send({ email: "admin@barbertest.dev", password: "password12" });
    adminToken = res.body.accessToken;
  });

  it("rejects a new shop reusing an existing barber phone", async () => {
    const res = await request(app)
      .post("/api/admin/shops")
      .set(auth(adminToken))
      .send({
        name: "Copycat Shop",
        description: "Tries to steal a barber phone.",
        address: "9 Copy Street",
        phone: "+9647500000099",
        cityId,
        chairCount: 1,
        openingHours: [{ weekday: 1, openMinute: 540, closeMinute: 1080 }],
        services: [{ name: "Cut", durationMin: 30, price: 12_000, isActive: true }],
        barbers: [{ name: "Impostor", phone: barberAPhone, isActive: true }],
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BARBER_PHONE_TAKEN");
  });
});

describe("booking approval workflow", () => {
  const date = openDate();

  it("new bookings are PENDING and hold the slot", async () => {
    const cust = await newUser("+9647508009001");
    const booking = await request(app)
      .post("/api/reservations")
      .set(auth(cust))
      .send({ shopId, serviceId, date, startMinute: 900, barberId: barberAId });
    expect(booking.status).toBe(201);
    expect(booking.body.reservation.status).toBe("PENDING");

    // A pending request blocks the same barber/time.
    const other = await newUser("+9647508009009");
    const clash = await request(app)
      .post("/api/reservations")
      .set(auth(other))
      .send({ shopId, serviceId, date, startMinute: 900, barberId: barberAId });
    expect(clash.status).toBe(409);
  });

  it("shows the pending booking in the customer's upcoming list", async () => {
    const cust = await newUser("+9647508009002");
    const booking = await request(app)
      .post("/api/reservations")
      .set(auth(cust))
      .send({ shopId, serviceId, date, startMinute: 930, barberId: barberAId });
    const up = await request(app)
      .get("/api/reservations/mine")
      .query({ scope: "upcoming" })
      .set(auth(cust));
    const mine = up.body.reservations.find(
      (r: { id: string }) => r.id === booking.body.reservation.id,
    );
    expect(mine).toBeTruthy();
    expect(mine.status).toBe("PENDING");
  });

  it("barber accepts a request → CONFIRMED, customer notified, shows upcoming", async () => {
    const cust = await newUser("+9647508009003");
    const booking = await request(app)
      .post("/api/reservations")
      .set(auth(cust))
      .send({ shopId, serviceId, date, startMinute: 960, barberId: barberAId });
    const id = booking.body.reservation.id;

    const reqs = await request(app).get("/api/barber/requests").set(auth(barberAToken));
    expect(reqs.status).toBe(200);
    expect(reqs.body.requests.some((r: { id: string }) => r.id === id)).toBe(true);

    const accept = await request(app)
      .post(`/api/barber/reservations/${id}/accept`)
      .set(auth(barberAToken));
    expect(accept.status).toBe(200);
    expect(accept.body.reservation.status).toBe("CONFIRMED");

    const notifs = await request(app).get("/api/notifications").set(auth(cust));
    expect(notifs.body.unread).toBeGreaterThanOrEqual(1);
    expect(notifs.body.notifications[0].type).toBe("BOOKING_ACCEPTED");

    const up = await request(app)
      .get("/api/reservations/mine")
      .query({ scope: "upcoming" })
      .set(auth(cust));
    const mine = up.body.reservations.find((r: { id: string }) => r.id === id);
    expect(mine.status).toBe("CONFIRMED");
  });

  it("barber declines → DECLINED, customer notified, frees the slot", async () => {
    const cust = await newUser("+9647508009004");
    const booking = await request(app)
      .post("/api/reservations")
      .set(auth(cust))
      .send({ shopId, serviceId, date, startMinute: 990, barberId: barberAId });
    const id = booking.body.reservation.id;

    const decline = await request(app)
      .post(`/api/barber/reservations/${id}/decline`)
      .set(auth(barberAToken));
    expect(decline.status).toBe(200);
    expect(decline.body.reservation.status).toBe("DECLINED");

    const notifs = await request(app).get("/api/notifications").set(auth(cust));
    expect(notifs.body.notifications[0].type).toBe("BOOKING_DECLINED");

    // Declined frees the slot — someone else can now book it.
    const other = await newUser("+9647508009005");
    const rebook = await request(app)
      .post("/api/reservations")
      .set(auth(other))
      .send({ shopId, serviceId, date, startMinute: 990, barberId: barberAId });
    expect(rebook.status).toBe(201);
  });

  it("only the assigned barber may decide", async () => {
    const cust = await newUser("+9647508009006");
    const booking = await request(app)
      .post("/api/reservations")
      .set(auth(cust))
      .send({ shopId, serviceId, date, startMinute: 1020, barberId: barberAId });
    const id = booking.body.reservation.id;
    // Barber B tries to accept Barber A's request.
    const res = await request(app)
      .post(`/api/barber/reservations/${id}/accept`)
      .set(auth(barberBToken));
    expect(res.status).toBe(404);
  });

  it("limits a customer to one active booking at a time", async () => {
    const cust = await newUser("+9647508009008");
    const first = await request(app)
      .post("/api/reservations")
      .set(auth(cust))
      .send({ shopId, serviceId, date, startMinute: 630, barberId: barberBId });
    expect(first.status).toBe(201);

    // A second booking while the first is still active is refused.
    const second = await request(app)
      .post("/api/reservations")
      .set(auth(cust))
      .send({ shopId, serviceId, date, startMinute: 540, barberId: barberBId });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("ONE_ACTIVE_BOOKING");

    // After cancelling the first, they can book again.
    await request(app)
      .post(`/api/reservations/${first.body.reservation.id}/cancel`)
      .set(auth(cust));
    const third = await request(app)
      .post("/api/reservations")
      .set(auth(cust))
      .send({ shopId, serviceId, date, startMinute: 540, barberId: barberBId });
    expect(third.status).toBe(201);
  });

  it("rejects deciding an already-handled request", async () => {
    const cust = await newUser("+9647508009007");
    const booking = await request(app)
      .post("/api/reservations")
      .set(auth(cust))
      .send({ shopId, serviceId, date, startMinute: 1050, barberId: barberAId });
    const id = booking.body.reservation.id;
    await request(app).post(`/api/barber/reservations/${id}/accept`).set(auth(barberAToken));
    const again = await request(app)
      .post(`/api/barber/reservations/${id}/decline`)
      .set(auth(barberAToken));
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("ALREADY_DECIDED");
  });
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function newUser(phone: string): Promise<string> {
  const reqRes = await request(app).post("/api/auth/otp/request").send({ phone });
  const verifyRes = await request(app)
    .post("/api/auth/otp/verify")
    .send({ requestId: reqRes.body.requestId, phone, code: reqRes.body.devCode });
  return verifyRes.body.accessToken;
}
