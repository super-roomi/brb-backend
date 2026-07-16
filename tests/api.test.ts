import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { ApiError } from "../src/lib/errors.js";
import { weekdayOfLocalDate } from "../src/lib/time.js";
import { verifyGoogleIdToken } from "../src/lib/googleAuth.js";

// Real verification needs Google credentials; tests inject identities instead.
vi.mock("../src/lib/googleAuth.js", () => ({
  verifyGoogleIdToken: vi.fn(),
}));
const mockVerifyGoogle = vi.mocked(verifyGoogleIdToken);

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

describe("auth: Google OAuth + test-login", () => {
  const email = "main@test.dev";

  it("rejects a malformed test-login email", async () => {
    const res = await request(app)
      .post("/api/auth/test-login")
      .send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("test-login creates the user and issues tokens", async () => {
    const res = await request(app)
      .post("/api/auth/test-login")
      .send({ email, name: "Test User" });
    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.name).toBe("Test User");
    userToken = res.body.accessToken;
    userRefresh = res.body.refreshToken;

    const again = await request(app).post("/api/auth/test-login").send({ email });
    expect(again.status).toBe(200);
    expect(again.body.isNewUser).toBe(false);
  });

  it("google sign-in creates a user, then recognizes them by googleId", async () => {
    mockVerifyGoogle.mockResolvedValue({
      googleId: "g-sub-1",
      email: "google.user@test.dev",
      name: "Google User",
    });
    const first = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "x".repeat(32) });
    expect(first.status).toBe(200);
    expect(first.body.isNewUser).toBe(true);
    expect(first.body.user.email).toBe("google.user@test.dev");
    expect(first.body.user.name).toBe("Google User");

    const second = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "x".repeat(32) });
    expect(second.status).toBe(200);
    expect(second.body.isNewUser).toBe(false);
    expect(second.body.user.id).toBe(first.body.user.id);
  });

  it("google sign-in links a pre-existing user row by email", async () => {
    const pre = await prisma.user.create({
      data: { email: "linked@test.dev", name: "Pre Existing" },
    });
    mockVerifyGoogle.mockResolvedValue({
      googleId: "g-sub-2",
      email: "linked@test.dev",
      name: "Ignored — row already has a name",
    });
    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "x".repeat(32) });
    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBe(false);
    expect(res.body.user.id).toBe(pre.id);
    expect(res.body.user.name).toBe("Pre Existing");
    const row = await prisma.user.findUnique({ where: { id: pre.id } });
    expect(row!.googleId).toBe("g-sub-2");
  });

  it("rejects an invalid google token", async () => {
    mockVerifyGoogle.mockRejectedValue(
      ApiError.unauthorized("Google sign-in failed", "GOOGLE_TOKEN_INVALID"),
    );
    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "x".repeat(32) });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("GOOGLE_TOKEN_INVALID");
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
    expect(me.body.user.email).toBe(email);
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

    const other = await newUserToken("other@test.dev");
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
    const user = await prisma.user.findUnique({ where: { email: "main@test.dev" } });
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
    const emails = [1, 2, 3, 4, 5].map((n) => `racer${n}@test.dev`);
    const tokens = await Promise.all(emails.map((e) => newUserToken(e)));
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
    expect(conflicts).toHaveLength(emails.length - 1);
    for (const c of conflicts) expect(c.body.error.code).toBe("SLOT_TAKEN");
  });
});

describe("reviews", () => {
  it("blocks reviews without a completed visit", async () => {
    const fresh = await newUserToken("fresh@test.dev");
    const res = await request(app)
      .put(`/api/shops/${shopId}/review`)
      .set(auth(fresh))
      .send({ rating: 5, comment: "Never actually visited" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("REVIEW_REQUIRES_VISIT");
  });

  it("accepts a review after a completed visit and updates the aggregate", async () => {
    const user = await prisma.user.findUnique({ where: { email: "main@test.dev" } });
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

describe("content localization", () => {
  it("serves per-language names, falling back to base when a translation is missing", async () => {
    // Add an Arabic name to the test shop; leave Kurdish unset.
    const patch = await request(app)
      .patch(`/api/admin/shops/${shopId}`)
      .set(auth(adminToken))
      .send({ nameAr: "صالون الاختبار" });
    expect(patch.status).toBe(200);

    const ar = await request(app).get(`/api/shops/${shopId}`).query({ lang: "ar" });
    expect(ar.body.shop.name).toBe("صالون الاختبار");

    // No Kurdish translation set → falls back to the base (English) name.
    const ckb = await request(app).get(`/api/shops/${shopId}`).query({ lang: "ckb" });
    expect(ckb.body.shop.name).toBe("Testable Cuts");

    // No/unknown lang → base name.
    const en = await request(app).get(`/api/shops/${shopId}`);
    expect(en.body.shop.name).toBe("Testable Cuts");
  });
});

describe("plans: deletion", () => {
  it("refuses to delete a plan that is in use", async () => {
    const res = await request(app)
      .delete(`/api/admin/plans/${planId}`)
      .set(auth(adminToken));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PLAN_IN_USE");
  });

  it("deletes an unused plan", async () => {
    const created = await request(app)
      .post("/api/admin/plans")
      .set(auth(adminToken))
      .send({ name: "Disposable", monthlyPrice: 1000 });
    expect(created.status).toBe(201);
    const del = await request(app)
      .delete(`/api/admin/plans/${created.body.plan.id}`)
      .set(auth(adminToken));
    expect(del.status).toBe(200);
  });
});

describe("barber of the week", () => {
  it("rejects non-featured-tier shops", async () => {
    // The test shop's plan is not a featured tier → not eligible.
    const res = await request(app)
      .post("/api/admin/barber-of-week")
      .set(auth(adminToken))
      .send({ shopIds: [shopId] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BOTW_INELIGIBLE");
  });

  it("clears the selection with an empty list", async () => {
    const res = await request(app)
      .post("/api/admin/barber-of-week")
      .set(auth(adminToken))
      .send({ shopIds: [] });
    expect(res.status).toBe(200);
    const feed = await request(app).get("/api/shops/of-the-week");
    expect(feed.status).toBe(200);
    expect(feed.body.shops).toEqual([]);
  });

  it("features a live featured-tier shop end-to-end and notifies users", async () => {
    const plan = await request(app)
      .post("/api/admin/plans")
      .set(auth(adminToken))
      .send({ name: "Master", monthlyPrice: 25000, isFeaturedTier: true });
    const created = await request(app)
      .post("/api/admin/shops")
      .set(auth(adminToken))
      .send({
        name: "Master Cuts",
        description: "Featured-tier shop used for Barber of the Week.",
        address: "9 Feature Street",
        phone: "+9647500000009",
        cityId,
        chairCount: 1,
        openingHours: [{ weekday: 1, openMinute: 540, closeMinute: 1080 }],
        services: [{ name: "Cut", durationMin: 30, price: 25000 }],
      });
    const newShopId = created.body.shop.id;
    await request(app)
      .put(`/api/admin/shops/${newShopId}/subscription`)
      .set(auth(adminToken))
      .send({ planId: plan.body.plan.id, months: 1 });
    await request(app)
      .patch(`/api/admin/shops/${newShopId}/visibility`)
      .set(auth(adminToken))
      .send({ isVisible: true });

    const conf = await request(app)
      .post("/api/admin/barber-of-week")
      .set(auth(adminToken))
      .send({ shopIds: [newShopId] });
    expect(conf.status).toBe(200);
    expect(conf.body.count).toBe(1);
    expect(conf.body.notified).toBeGreaterThan(0);

    const feed = await request(app).get("/api/shops/of-the-week");
    expect(feed.body.shops.map((s: { id: string }) => s.id)).toEqual([newShopId]);

    const notifs = await request(app).get("/api/notifications").set(auth(userToken));
    expect(
      notifs.body.notifications.some((n: { type: string }) => n.type === "BARBER_OF_WEEK"),
    ).toBe(true);
  });
});

describe("booking grace period (bufferMin)", () => {
  const date = openDate();
  let bufShopId: string;
  let bufServiceId: string;

  it("admin sets a 20-minute grace period on a shop", async () => {
    const created = await request(app)
      .post("/api/admin/shops")
      .set(auth(adminToken))
      .send({
        name: "Buffered Cuts",
        description: "Shop with a grace period between bookings.",
        address: "5 Buffer Street",
        phone: "+9647500000055",
        cityId,
        chairCount: 1,
        bufferMin: 20,
        openingHours: Array.from({ length: 7 }, (_, weekday) => ({
          weekday,
          openMinute: 9 * 60,
          closeMinute: 18 * 60,
        })),
        services: [{ name: "Cut", durationMin: 30, price: 15000 }],
      });
    expect(created.status).toBe(201);
    bufShopId = created.body.shop.id;
    await request(app)
      .put(`/api/admin/shops/${bufShopId}/subscription`)
      .set(auth(adminToken))
      .send({ planId, months: 1 });
    await request(app)
      .patch(`/api/admin/shops/${bufShopId}/visibility`)
      .set(auth(adminToken))
      .send({ isVisible: true });
    const detail = await request(app).get(`/api/shops/${bufShopId}`);
    expect(detail.status).toBe(200);
    bufServiceId = detail.body.shop.services[0].id;
  });

  it("blocks slots inside the grace window and frees the first one past it", async () => {
    // First customer books 10:00–10:30. With a 20-min buffer the same chair is
    // blocked until 10:50, so 10:30 and 10:45 must vanish; 11:00 stays.
    const a = await newUserToken("notify.a@test.dev");
    const book = await request(app)
      .post("/api/reservations")
      .set(auth(a))
      .send({ shopId: bufShopId, serviceId: bufServiceId, date, startMinute: 600 });
    expect(book.status).toBe(201);

    const avail = await request(app)
      .get(`/api/shops/${bufShopId}/availability`)
      .query({ date, serviceId: bufServiceId });
    const minutes = avail.body.slots.map((s: { startMinute: number }) => s.startMinute);
    expect(minutes).not.toContain(630); // 10:30 — back-to-back, no grace
    expect(minutes).not.toContain(645); // 10:45 — still inside the 20-min grace
    expect(minutes).toContain(660); // 11:00 — first slot ≥ 20 min after 10:30
    // The grace also protects the booking's start: a 9:30–10:00 cut would leave
    // zero rest before the 10:00 appointment, so 9:30 must be blocked too.
    expect(minutes).not.toContain(570);

    // Direct API attempt inside the grace window is rejected server-side.
    const b = await newUserToken("notify.b@test.dev");
    const tooClose = await request(app)
      .post("/api/reservations")
      .set(auth(b))
      .send({ shopId: bufShopId, serviceId: bufServiceId, date, startMinute: 630 });
    expect(tooClose.status).toBe(409);
    expect(tooClose.body.error.code).toBe("SLOT_TAKEN");

    // …and the first slot past the grace period books fine.
    const ok = await request(app)
      .post("/api/reservations")
      .set(auth(b))
      .send({ shopId: bufShopId, serviceId: bufServiceId, date, startMinute: 660 });
    expect(ok.status).toBe(201);
  });
});

describe("device tokens (FCM)", () => {
  it("requires auth", async () => {
    const res = await request(app)
      .post("/api/notifications/device")
      .send({ token: "x".repeat(20) });
    expect(res.status).toBe(401);
  });

  it("registers (idempotently) and unregisters a device token", async () => {
    const body = { token: "test-fcm-token-abc123", platform: "android" };
    const reg = await request(app)
      .post("/api/notifications/device")
      .set(auth(userToken))
      .send(body);
    expect(reg.status).toBe(200);
    // Re-registering the same token is an upsert (no duplicate / no error).
    const reg2 = await request(app)
      .post("/api/notifications/device")
      .set(auth(userToken))
      .send(body);
    expect(reg2.status).toBe(200);
    const un = await request(app)
      .post("/api/notifications/device/unregister")
      .set(auth(userToken))
      .send({ token: body.token });
    expect(un.status).toBe(200);
  });
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function newUserToken(email: string): Promise<string> {
  const res = await request(app).post("/api/auth/test-login").send({ email });
  return res.body.accessToken;
}
