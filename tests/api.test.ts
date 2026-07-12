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
let hiddenShopId: string;
let userToken: string;
let userRefresh: string;
let adminToken: string;

// First date 2..8 days out that is not Friday (weekday 5, seeded closed day).
function openDate(): string {
  for (let d = 2; d <= 8; d++) {
    const dt = new Date(Date.now() + d * 86_400_000);
    const s = dt.toISOString().slice(0, 10);
    if (weekdayOfLocalDate(s) !== 5) return s;
  }
  throw new Error("unreachable");
}

beforeAll(async () => {
  // Fixtures: one live shop, one hidden shop, plan, admin.
  const city = await prisma.city.create({ data: { name: "Testville", slug: "testville" } });
  cityId = city.id;
  const plan = await prisma.plan.create({
    data: { name: "Test Plan", monthlyPrice: 10_000, features: "", isFeaturedTier: false },
  });
  planId = plan.id;

  const periodEnd = new Date(Date.now() + 30 * 86_400_000);
  const allWeek = Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    openMinute: 9 * 60,
    closeMinute: 18 * 60,
  })).filter((h) => h.weekday !== 5);

  const shop = await prisma.barbershop.create({
    data: {
      name: "Testable Cuts",
      description: "A shop used in automated tests.",
      address: "1 Test Street",
      phone: "+9647500000001",
      cityId,
      chairCount: 1,
      isVisible: true,
      services: { create: [{ name: "Cut", durationMin: 30, price: 10_000 }] },
      openingHours: { create: allWeek },
      subscription: {
        create: {
          planId,
          status: "ACTIVE",
          currentPeriodStart: new Date(),
          currentPeriodEnd: periodEnd,
        },
      },
    },
    include: { services: true },
  });
  shopId = shop.id;
  serviceId = shop.services[0].id;

  const hidden = await prisma.barbershop.create({
    data: {
      name: "Hidden Shop",
      description: "Visible flag off — must not appear in the app.",
      address: "2 Test Street",
      phone: "+9647500000002",
      cityId,
      isVisible: false,
      services: { create: [{ name: "Cut", durationMin: 30, price: 10_000 }] },
      subscription: {
        create: {
          planId,
          status: "ACTIVE",
          currentPeriodStart: new Date(),
          currentPeriodEnd: periodEnd,
        },
      },
    },
  });
  hiddenShopId = hidden.id;

  const bcrypt = (await import("bcryptjs")).default;
  await prisma.adminUser.create({
    data: {
      email: "admin@test.dev",
      name: "Test Admin",
      passwordHash: await bcrypt.hash("test-password-1", 10),
    },
  });
});

describe("health", () => {
  it("responds ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("auth: phone + OTP", () => {
  const phone = "+9647501112233";

  it("rejects malformed phone numbers", async () => {
    const res = await request(app).post("/api/auth/otp/request").send({ phone: "12345678" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PHONE");
  });

  it("issues an OTP and verifies it, creating the user", async () => {
    const reqRes = await request(app).post("/api/auth/otp/request").send({ phone });
    expect(reqRes.status).toBe(200);
    expect(reqRes.body.requestId).toBeTruthy();
    expect(reqRes.body.devCode).toMatch(/^\d{6}$/);

    const wrong = await request(app)
      .post("/api/auth/otp/verify")
      .send({ requestId: reqRes.body.requestId, phone, code: "000000" });
    // Astronomically unlikely the random code is 000000; treat 200 as fluke-proofed by next assert
    if (wrong.status !== 200) {
      expect(wrong.body.error.code).toBe("OTP_WRONG");
    }

    const verifyRes = await request(app)
      .post("/api/auth/otp/verify")
      .send({
        requestId: reqRes.body.requestId,
        phone,
        code: reqRes.body.devCode,
        name: "Test User",
      });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.isNewUser).toBe(true);
    expect(verifyRes.body.user.name).toBe("Test User");
    userToken = verifyRes.body.accessToken;
    userRefresh = verifyRes.body.refreshToken;
  });

  it("rejects OTP reuse", async () => {
    const reqRes = await request(app).post("/api/auth/otp/request").send({ phone: "+9647501112299" });
    // cooldown applies per-phone, new phone fine
    const v1 = await request(app)
      .post("/api/auth/otp/verify")
      .send({ requestId: reqRes.body.requestId, phone: "+9647501112299", code: reqRes.body.devCode });
    expect(v1.status).toBe(200);
    const v2 = await request(app)
      .post("/api/auth/otp/verify")
      .send({ requestId: reqRes.body.requestId, phone: "+9647501112299", code: reqRes.body.devCode });
    expect(v2.status).toBe(400);
    expect(v2.body.error.code).toBe("OTP_USED");
  });

  it("enforces resend cooldown", async () => {
    const first = await request(app).post("/api/auth/otp/request").send({ phone: "+9647501112255" });
    expect(first.status).toBe(200);
    const second = await request(app).post("/api/auth/otp/request").send({ phone: "+9647501112255" });
    expect(second.status).toBe(429);
  });

  it("rotates refresh tokens and kills the old one", async () => {
    const r1 = await request(app).post("/api/auth/refresh").send({ refreshToken: userRefresh });
    expect(r1.status).toBe(200);
    const r2 = await request(app).post("/api/auth/refresh").send({ refreshToken: userRefresh });
    expect(r2.status).toBe(401);
    userToken = r1.body.accessToken;
    userRefresh = r1.body.refreshToken;
  });

  it("returns the profile with a valid token and rejects without", async () => {
    const me = await request(app).get("/api/auth/me").set(auth(userToken));
    expect(me.status).toBe(200);
    expect(me.body.user.phone).toBe(phone);
    const anon = await request(app).get("/api/auth/me");
    expect(anon.status).toBe(401);
  });
});

describe("catalog", () => {
  it("lists only live shops", async () => {
    const res = await request(app).get("/api/shops").query({ cityId });
    expect(res.status).toBe(200);
    const names = res.body.shops.map((s: { name: string }) => s.name);
    expect(names).toContain("Testable Cuts");
    expect(names).not.toContain("Hidden Shop");
  });

  it("hides shop detail for hidden shops", async () => {
    const res = await request(app).get(`/api/shops/${hiddenShopId}`);
    expect(res.status).toBe(404);
  });

  it("serves shop detail with services and hours", async () => {
    const res = await request(app).get(`/api/shops/${shopId}`);
    expect(res.status).toBe(200);
    expect(res.body.shop.services).toHaveLength(1);
    expect(res.body.shop.openingHours.length).toBeGreaterThan(0);
  });

  it("computes availability aligned to opening hours", async () => {
    const res = await request(app)
      .get(`/api/shops/${shopId}/availability`)
      .query({ date: openDate(), serviceId });
    expect(res.status).toBe(200);
    expect(res.body.slots.length).toBeGreaterThan(0);
    expect(res.body.slots[0].startMinute).toBe(9 * 60);
  });
});

describe("reservations", () => {
  const date = openDate();

  it("requires auth", async () => {
    const res = await request(app)
      .post("/api/reservations")
      .send({ shopId, serviceId, date, startMinute: 600 });
    expect(res.status).toBe(401);
  });

  it("creates a booking, then rejects an overlapping one (1 chair)", async () => {
    const ok = await request(app)
      .post("/api/reservations")
      .set(auth(userToken))
      .send({ shopId, serviceId, date, startMinute: 600 });
    expect(ok.status).toBe(201);
    expect(ok.body.reservation.status).toBe("PENDING");

    const other = await newUserToken("+9647501112277");
    const clash = await request(app)
      .post("/api/reservations")
      .set(auth(other))
      .send({ shopId, serviceId, date, startMinute: 615 }); // overlaps 600–630
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("SLOT_TAKEN");

    const free = await request(app)
      .post("/api/reservations")
      .set(auth(other))
      .send({ shopId, serviceId, date, startMinute: 630 });
    expect(free.status).toBe(201);
  });

  it("removes booked slots from availability", async () => {
    const res = await request(app)
      .get(`/api/shops/${shopId}/availability`)
      .query({ date, serviceId });
    const minutes = res.body.slots.map((s: { startMinute: number }) => s.startMinute);
    expect(minutes).not.toContain(600);
    expect(minutes).not.toContain(615);
  });

  it("blocks double-booking the same user across shops/times", async () => {
    const res = await request(app)
      .post("/api/reservations")
      .set(auth(userToken))
      .send({ shopId, serviceId, date, startMinute: 600 });
    expect(res.status).toBe(409);
  });

  it("rejects times outside opening hours", async () => {
    const res = await request(app)
      .post("/api/reservations")
      .set(auth(userToken))
      .send({ shopId, serviceId, date, startMinute: 8 * 60 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("OUTSIDE_HOURS");
  });

  it("lists and cancels upcoming reservations", async () => {
    const list = await request(app)
      .get("/api/reservations/mine")
      .query({ scope: "upcoming" })
      .set(auth(userToken));
    expect(list.status).toBe(200);
    expect(list.body.reservations.length).toBeGreaterThan(0);

    const id = list.body.reservations[0].id;
    const cancel = await request(app)
      .post(`/api/reservations/${id}/cancel`)
      .set(auth(userToken));
    expect(cancel.status).toBe(200);
    expect(cancel.body.reservation.status).toBe("CANCELLED");
  });

  it("enforces the cancellation cutoff", async () => {
    const user = await prisma.user.findUnique({ where: { phone: "+9647501112233" } });
    const soon = await prisma.reservation.create({
      data: {
        userId: user!.id,
        shopId,
        serviceId,
        startsAt: new Date(Date.now() + 60 * 60_000), // 1h away < 2h cutoff
        endsAt: new Date(Date.now() + 90 * 60_000),
        status: "CONFIRMED",
      },
    });
    const res = await request(app)
      .post(`/api/reservations/${soon.id}/cancel`)
      .set(auth(userToken));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CANCEL_CUTOFF");
  });
});

describe("reservation concurrency", () => {
  const date = openDate();

  it("lets only one of many simultaneous bookings win the same slot", async () => {
    // Distinct users so the one-active-booking rule doesn't mask the capacity
    // check — every request is eligible, so only slot capacity should stop the
    // losers. Without the Serializable transaction these would all read "free"
    // and all insert; exactly one 201 is the guarantee we're protecting.
    const phones = [
      "+9647500010001",
      "+9647500010002",
      "+9647500010003",
      "+9647500010004",
      "+9647500010005",
    ];
    const tokens = await Promise.all(phones.map((p) => newUserToken(p)));
    const startMinute = 15 * 60; // 15:00 — not used by other reservation tests

    const results = await Promise.all(
      tokens.map((t) =>
        request(app)
          .post("/api/reservations")
          .set(auth(t))
          .send({ shopId, serviceId, date, startMinute }),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(phones.length - 1);
    for (const c of conflicts) expect(c.body.error.code).toBe("SLOT_TAKEN");
  });
});

describe("reviews", () => {
  it("blocks reviews without a completed visit", async () => {
    const fresh = await newUserToken("+9647501112288");
    const res = await request(app)
      .put(`/api/shops/${shopId}/review`)
      .set(auth(fresh))
      .send({ rating: 5, comment: "Never actually visited" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("REVIEW_REQUIRES_VISIT");
  });

  it("accepts a review after a completed visit and updates the aggregate", async () => {
    const user = await prisma.user.findUnique({ where: { phone: "+9647501112233" } });
    await prisma.reservation.create({
      data: {
        userId: user!.id,
        shopId,
        serviceId,
        startsAt: new Date(Date.now() - 2 * 86_400_000),
        endsAt: new Date(Date.now() - 2 * 86_400_000 + 30 * 60_000),
        status: "CONFIRMED",
      },
    });
    const res = await request(app)
      .put(`/api/shops/${shopId}/review`)
      .set(auth(userToken))
      .send({ rating: 4, comment: "Clean cut, friendly barber." });
    expect(res.status).toBe(200);

    const shop = await request(app).get(`/api/shops/${shopId}`);
    expect(shop.body.shop.ratingCount).toBe(1);
    expect(shop.body.shop.ratingAvg).toBe(4);

    const reviews = await request(app).get(`/api/shops/${shopId}/reviews`);
    expect(reviews.body.reviews[0].comment).toContain("Clean cut");
  });
});

describe("admin", () => {
  it("rejects bad credentials", async () => {
    const res = await request(app)
      .post("/api/admin/login")
      .send({ email: "admin@test.dev", password: "wrong-password" });
    expect(res.status).toBe(401);
  });

  it("logs in and reads the summary", async () => {
    const res = await request(app)
      .post("/api/admin/login")
      .send({ email: "admin@test.dev", password: "test-password-1" });
    expect(res.status).toBe(200);
    adminToken = res.body.accessToken;

    const summary = await request(app).get("/api/admin/summary").set(auth(adminToken));
    expect(summary.status).toBe(200);
    expect(summary.body.shops).toBeGreaterThanOrEqual(2);
  });

  it("blocks user tokens from admin routes", async () => {
    const res = await request(app).get("/api/admin/summary").set(auth(userToken));
    expect(res.status).toBe(403);
  });

  it("creates a shop (hidden by default), toggles visibility live", async () => {
    const created = await request(app)
      .post("/api/admin/shops")
      .set(auth(adminToken))
      .send({
        name: "Admin Made Shop",
        description: "Created through the admin API in tests.",
        address: "3 Test Street",
        phone: "+9647500000003",
        cityId,
        chairCount: 2,
        openingHours: [{ weekday: 1, openMinute: 540, closeMinute: 1080 }],
        services: [{ name: "Cut", durationMin: 30, price: 12_000, isActive: true }],
      });
    expect(created.status).toBe(201);
    const newShopId = created.body.shop.id;

    // Hidden + no subscription → not in the app.
    let list = await request(app).get("/api/shops").query({ cityId });
    let names = list.body.shops.map((s: { name: string }) => s.name);
    expect(names).not.toContain("Admin Made Shop");

    // Assign subscription + flip visibility → appears.
    const sub = await request(app)
      .put(`/api/admin/shops/${newShopId}/subscription`)
      .set(auth(adminToken))
      .send({ planId, months: 3 });
    expect(sub.status).toBe(200);

    const vis = await request(app)
      .patch(`/api/admin/shops/${newShopId}/visibility`)
      .set(auth(adminToken))
      .send({ isVisible: true });
    expect(vis.status).toBe(200);

    list = await request(app).get("/api/shops").query({ cityId });
    names = list.body.shops.map((s: { name: string }) => s.name);
    expect(names).toContain("Admin Made Shop");

    // Cancel subscription → disappears even though isVisible stays true.
    await request(app)
      .delete(`/api/admin/shops/${newShopId}/subscription`)
      .set(auth(adminToken));
    list = await request(app).get("/api/shops").query({ cityId });
    names = list.body.shops.map((s: { name: string }) => s.name);
    expect(names).not.toContain("Admin Made Shop");
  });

  it("manages plans", async () => {
    const created = await request(app)
      .post("/api/admin/plans")
      .set(auth(adminToken))
      .send({ name: "Starter", monthlyPrice: 5_000, features: "Listed" });
    expect(created.status).toBe(201);
    const updated = await request(app)
      .patch(`/api/admin/plans/${created.body.plan.id}`)
      .set(auth(adminToken))
      .send({ monthlyPrice: 7_500 });
    expect(updated.status).toBe(200);
    expect(updated.body.plan.monthlyPrice).toBe(7_500);
  });
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function newUserToken(phone: string): Promise<string> {
  const reqRes = await request(app).post("/api/auth/otp/request").send({ phone });
  const verifyRes = await request(app)
    .post("/api/auth/otp/verify")
    .send({ requestId: reqRes.body.requestId, phone, code: reqRes.body.devCode });
  return verifyRes.body.accessToken;
}
