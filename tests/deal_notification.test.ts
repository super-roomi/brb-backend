import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";

// When an admin turns on a shop's bring-a-friend deal, every customer should
// get a (localized) notification about it.

const app = createApp();
let adminToken: string;
let shopId: string;
let cityId: string;
let planId: string;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function makeLiveShop(discount: number): Promise<string> {
  const shop = await prisma.barbershop.create({
    data: {
      name: "Deal Cuts",
      description: "A shop that will start a deal.",
      address: "1 Deal Street",
      phone: "+9647500000030",
      cityId,
      isVisible: true,
      referralDiscount: discount,
      services: { create: [{ name: "Cut", durationMin: 30, price: 15000 }] },
      subscription: {
        create: {
          planId,
          status: "ACTIVE",
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        },
      },
    },
  });
  return shop.id;
}

// The admin PATCH requires the full shop payload shape (partial), but sending
// just referralDiscount is enough to flip it.
async function setDiscount(id: string, amount: number) {
  return request(app)
    .patch(`/api/admin/shops/${id}`)
    .set(auth(adminToken))
    .send({ referralDiscount: amount });
}

beforeAll(async () => {
  const city = await prisma.city.create({ data: { name: "Dealville", slug: "dealville" } });
  cityId = city.id;
  const plan = await prisma.plan.create({
    data: { name: "Deal Plan", monthlyPrice: 10000, features: "", isFeaturedTier: false },
  });
  planId = plan.id;
  const bcrypt = (await import("bcryptjs")).default;
  await prisma.adminUser.create({
    data: {
      email: "deal-admin@test.dev",
      name: "Deal Admin",
      passwordHash: await bcrypt.hash("deal-password-1", 10),
    },
  });
  adminToken = (
    await request(app)
      .post("/api/admin/login")
      .send({ email: "deal-admin@test.dev", password: "deal-password-1" })
  ).body.accessToken;

  // A Kurdish-speaking customer, so we can check the copy is localized.
  await request(app).post("/api/auth/test-login").send({ email: "deal-customer@test.dev" });
  const u = await prisma.user.findUniqueOrThrow({ where: { email: "deal-customer@test.dev" } });
  await prisma.user.update({ where: { id: u.id }, data: { lang: "ckb" } });
});

describe("starting a deal notifies customers", () => {
  it("writes a localized REFERRAL_DEAL notification when the promo turns on", async () => {
    shopId = await makeLiveShop(0);
    const before = await prisma.notification.count({ where: { type: "REFERRAL_DEAL" } });

    const res = await setDiscount(shopId, 2500);
    expect(res.status).toBe(200);

    // The announcement is fire-and-forget, so give it a moment to land.
    await vi.waitFor(
      async () => {
        expect(await prisma.notification.count({ where: { type: "REFERRAL_DEAL" } }))
          .toBeGreaterThan(before);
      },
      { timeout: 3000 },
    );

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "deal-customer@test.dev" } });
    const note = await prisma.notification.findFirstOrThrow({
      where: { userId: user.id, type: "REFERRAL_DEAL" },
      orderBy: { createdAt: "desc" },
    });
    // Kurdish copy for this customer, and it mentions the shop.
    expect(note.title).toBe("داشکاندنی نوێ: هاوڕێیەک بهێنە");
    expect(note.body).toContain("Deal Cuts");
  });

  it("does not re-announce when the promo was already on", async () => {
    const id = await makeLiveShop(2500); // already on
    const before = await prisma.notification.count({ where: { type: "REFERRAL_DEAL" } });
    // Change the amount but it was never 0 → not a "start".
    const res = await setDiscount(id, 3000);
    expect(res.status).toBe(200);
    // Give any (unexpected) broadcast a chance, then assert nothing new.
    await new Promise((r) => setTimeout(r, 500));
    expect(await prisma.notification.count({ where: { type: "REFERRAL_DEAL" } })).toBe(before);
  });

  it("does not announce a deal on a hidden shop", async () => {
    const shop = await prisma.barbershop.create({
      data: {
        name: "Hidden Deal Cuts",
        description: "Hidden shop turning on a deal.",
        address: "2 Deal Street",
        phone: "+9647500000031",
        cityId,
        isVisible: false,
        referralDiscount: 0,
        services: { create: [{ name: "Cut", durationMin: 30, price: 15000 }] },
        subscription: {
          create: {
            planId,
            status: "ACTIVE",
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
          },
        },
      },
    });
    const before = await prisma.notification.count({ where: { type: "REFERRAL_DEAL" } });
    const res = await setDiscount(shop.id, 2500);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    // Hidden shop → customers can't book it → no announcement.
    expect(await prisma.notification.count({ where: { type: "REFERRAL_DEAL" } })).toBe(before);
  });
});
