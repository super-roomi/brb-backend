import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { weekdayOfLocalDate } from "../src/lib/time.js";

// "Book for two" double booking: one person books two back-to-back cuts, both
// discounted, one barber, same visit.

const app = createApp();
const DISCOUNT = 2_500;
const PRICE = 15_000; // 30-min cut

let shopId: string;
let serviceId: string;
let barberId: string;
let aliceToken: string;
let aliceId: string;

function openDate(): string {
  for (let d = 2; d <= 9; d++) {
    const s = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    if (weekdayOfLocalDate(s) !== 5) return s;
  }
  throw new Error("unreachable");
}
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function login(email: string) {
  const r = await request(app).post("/api/auth/test-login").send({ email });
  return { token: r.body.accessToken as string, id: r.body.user.id as string };
}

async function clear() {
  await prisma.reservation.deleteMany({ where: { shopId } });
}

beforeAll(async () => {
  const city = await prisma.city.create({ data: { name: "Doubletown", slug: "doubletown" } });
  const plan = await prisma.plan.create({
    data: { name: "Double Plan", monthlyPrice: 10_000, features: "", isFeaturedTier: false },
  });
  // Single barber so the "one barber must be free for the whole block" rule bites.
  const hours = Array.from({ length: 7 }, (_, weekday) => ({
    weekday, openMinute: 9 * 60, closeMinute: 20 * 60,
  })).filter((h) => h.weekday !== 5);
  const shop = await prisma.barbershop.create({
    data: {
      name: "Double Cuts",
      description: "Runs book-for-two.",
      address: "1 Double Street",
      phone: "+9647500000020",
      cityId: city.id,
      chairCount: 1,
      isVisible: true,
      referralDiscount: DISCOUNT,
      services: { create: [{ name: "Cut", durationMin: 30, price: PRICE }] },
      openingHours: { create: hours },
      barbers: { create: [{ name: "Solo Barber", email: "solo.barber@test.dev", autoApprove: true }] },
      subscription: {
        create: {
          planId: plan.id, status: "ACTIVE",
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        },
      },
    },
    include: { services: true, barbers: true },
  });
  shopId = shop.id;
  serviceId = shop.services[0].id;
  barberId = shop.barbers[0].id;
  const a = await login("alice.double@test.dev");
  aliceToken = a.token; aliceId = a.id;
});

describe("creating a double", () => {
  it("makes two back-to-back cuts, same barber, both discounted", async () => {
    await clear();
    const date = openDate();
    const res = await request(app)
      .post("/api/reservations/double")
      .set(auth(aliceToken))
      .send({ shopId, date, startMinute: 10 * 60, firstServiceId: serviceId, secondServiceId: serviceId, guestName: "Bob" });
    expect(res.status).toBe(201);
    const cuts = res.body.reservations;
    expect(cuts).toHaveLength(2);

    // Both discounted, both grouped, one carries the guest name.
    for (const c of cuts) {
      expect(c.isDouble).toBe(true);
      expect(c.discountAmount).toBe(DISCOUNT);
      expect(c.payableAmount).toBe(PRICE - DISCOUNT);
      expect(c.groupId).toBe(cuts[0].groupId);
    }
    expect(cuts[0].guestName).toBeNull();
    expect(cuts[1].guestName).toBe("Bob");

    // Back-to-back: second starts exactly when the first ends.
    expect(cuts[1].startsAt).toBe(cuts[0].endsAt);

    // Both assigned to the one barber.
    const rows = await prisma.reservation.findMany({ where: { groupId: cuts[0].groupId } });
    expect(rows.every((r) => r.barberId === barberId)).toBe(true);
  });

  it("refuses at a shop not running the offer", async () => {
    await clear();
    await prisma.barbershop.update({ where: { id: shopId }, data: { referralDiscount: 0 } });
    const res = await request(app)
      .post("/api/reservations/double")
      .set(auth(aliceToken))
      .send({ shopId, date: openDate(), startMinute: 10 * 60, firstServiceId: serviceId, secondServiceId: serviceId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("REFERRAL_NOT_AVAILABLE");
    await prisma.barbershop.update({ where: { id: shopId }, data: { referralDiscount: DISCOUNT } });
  });
});

describe("scheduling accounts for both people's time", () => {
  it("does not offer a double slot whose second cut would hit a later booking", async () => {
    // The exact case from the brief: a single booking sits at a later time; a
    // double whose SECOND cut would run into it must not be offered.
    await clear();
    const date = openDate();
    const bob = await login("bob.double@test.dev");
    // Bob books a single 30-min cut at 11:00 (660). The only barber is now busy
    // 11:00-11:30.
    const single = await request(app)
      .post("/api/reservations")
      .set(auth(bob.token))
      .send({ shopId, serviceId, date, startMinute: 11 * 60 });
    expect(single.status).toBe(201);

    // A double of two 30-min cuts = a 60-min block. Ask for the day's slots.
    const avail = await request(app)
      .get(`/api/shops/${shopId}/double-availability`)
      .query({ date, firstServiceId: serviceId, secondServiceId: serviceId });
    expect(avail.status).toBe(200);
    expect(avail.body.blockMinutes).toBe(60);
    const starts: number[] = avail.body.slots.map((s: { startMinute: number }) => s.startMinute);

    // 10:30 (630) would run 10:30-11:30 and collide with Bob's 11:00 → excluded.
    expect(starts).not.toContain(630);
    // 10:00 (600) runs 10:00-11:00, ending exactly as Bob starts → allowed.
    expect(starts).toContain(600);
    // 11:00 itself is taken → excluded.
    expect(starts).not.toContain(660);

    await prisma.reservation.deleteMany({ where: { userId: bob.id } });
  });

  it("rejects a direct double booking that collides", async () => {
    await clear();
    const date = openDate();
    const bob = await login("bob2.double@test.dev");
    await request(app)
      .post("/api/reservations")
      .set(auth(bob.token))
      .send({ shopId, serviceId, date, startMinute: 11 * 60 });

    // Force the colliding double (10:30-11:30) directly.
    const res = await request(app)
      .post("/api/reservations/double")
      .set(auth(aliceToken))
      .send({ shopId, date, startMinute: 10 * 60 + 30, firstServiceId: serviceId, secondServiceId: serviceId });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SLOT_TAKEN");
    await prisma.reservation.deleteMany({ where: { userId: bob.id } });
  });
});

describe("the double is one booking", () => {
  it("cancelling either cut cancels both", async () => {
    await clear();
    const date = openDate();
    const res = await request(app)
      .post("/api/reservations/double")
      .set(auth(aliceToken))
      .send({ shopId, date, startMinute: 12 * 60, firstServiceId: serviceId, secondServiceId: serviceId, guestName: "Bob" });
    const cuts = res.body.reservations;

    // Cancel via the SECOND cut; the first must go too.
    const cancel = await request(app)
      .post(`/api/reservations/${cuts[1].id}/cancel`)
      .set(auth(aliceToken));
    expect(cancel.status).toBe(200);

    const rows = await prisma.reservation.findMany({ where: { groupId: cuts[0].groupId } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "CANCELLED")).toBe(true);
  });

  it("counts as the user's one active booking", async () => {
    await clear();
    const date = openDate();
    await request(app)
      .post("/api/reservations/double")
      .set(auth(aliceToken))
      .send({ shopId, date, startMinute: 14 * 60, firstServiceId: serviceId, secondServiceId: serviceId });
    // A second booking of any kind is now blocked.
    const single = await request(app)
      .post("/api/reservations")
      .set(auth(aliceToken))
      .send({ shopId, serviceId, date, startMinute: 16 * 60 });
    expect(single.status).toBe(409);
    expect(single.body.error.code).toBe("ONE_ACTIVE_BOOKING");
    await prisma.reservation.deleteMany({ where: { userId: aliceId } });
  });
});

describe("the barber sees the double", () => {
  it("shows the guest name, the discounted price, and the double flag", async () => {
    await clear();
    const date = openDate();
    await request(app)
      .post("/api/reservations/double")
      .set(auth(aliceToken))
      .send({ shopId, date, startMinute: 15 * 60, firstServiceId: serviceId, secondServiceId: serviceId, guestName: "Karwan" });

    // autoApprove is on, so both cuts are CONFIRMED; move them into "today".
    const barber = await login("solo.barber@test.dev");
    // Pull the pair into the shop-local "today" window, keeping them back-to-back
    // (moving both to one time would trip the no-overlap constraint).
    const grp = await prisma.reservation.findFirstOrThrow({ where: { shopId, guestName: "Karwan" } });
    const cuts = await prisma.reservation.findMany({
      where: { groupId: grp.groupId! },
      orderBy: { startsAt: "asc" },
    });
    const soon = new Date(Date.now() + 60 * 60_000);
    await prisma.reservation.update({
      where: { id: cuts[0].id },
      data: { startsAt: soon, endsAt: new Date(soon.getTime() + 30 * 60_000) },
    });
    await prisma.reservation.update({
      where: { id: cuts[1].id },
      data: {
        startsAt: new Date(soon.getTime() + 30 * 60_000),
        endsAt: new Date(soon.getTime() + 60 * 60_000),
      },
    });

    const today = await request(app).get("/api/barber/today").set(auth(barber.token));
    expect(today.status).toBe(200);
    const guestCut = today.body.appointments.find((a: { customerName: string }) => a.customerName === "Karwan");
    expect(guestCut).toBeTruthy();
    expect(guestCut.isDouble).toBe(true);
    expect(guestCut.price).toBe(PRICE - DISCOUNT);
    await prisma.reservation.deleteMany({ where: { userId: aliceId } });
  });
});
