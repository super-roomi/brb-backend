import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { weekdayOfLocalDate } from "../src/lib/time.js";
import { mintBarberToken } from "../src/services/referral.js";

// "Bring a friend": two customers at the same shop who turn up together each
// get a flat amount off, funded by the barber.
//
// The tests below are organised around the two proofs the feature depends on —
// LINKAGE (a shared single-use code) and PRESENCE (both scanning the barber's
// short-lived QR at the shop) — because the whole design rests on neither being
// sufficient alone.

const app = createApp();

const DISCOUNT = 2_500;
const PRICE = 20_000;

let shopId: string;
let serviceId: string;
let barberId: string;
let otherShopId: string;
let otherBarberId: string;
let aliceToken: string;
let bobToken: string;
let aliceId: string;
let bobId: string;

function openDate(offsetDays: number): string {
  for (let d = offsetDays; d <= offsetDays + 8; d++) {
    const s = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    if (weekdayOfLocalDate(s) !== 5) return s;
  }
  throw new Error("unreachable");
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function login(email: string): Promise<{ token: string; id: string }> {
  const res = await request(app).post("/api/auth/test-login").send({ email });
  return { token: res.body.accessToken, id: res.body.user.id };
}

/** Books directly through the API so the real booking rules apply. */
async function book(token: string, date: string, startMinute: number): Promise<string> {
  const res = await request(app)
    .post("/api/reservations")
    .set(auth(token))
    .send({ shopId, serviceId, date, startMinute });
  expect(res.status).toBe(201);
  return res.body.reservation.id;
}

/** Clears both customers' bookings so each test starts from a clean slate. */
async function clearBookings() {
  await prisma.referralPair.deleteMany({});
  await prisma.reservation.deleteMany({ where: { userId: { in: [aliceId, bobId] } } });
}

async function freshPair(): Promise<{ aliceRes: string; bobRes: string; code: string }> {
  await clearBookings();
  const date = openDate(2);
  const aliceRes = await book(aliceToken, date, 10 * 60);
  const bobRes = await book(bobToken, date, 11 * 60);
  const invite = await request(app)
    .post(`/api/reservations/${aliceRes}/referral/invite`)
    .set(auth(aliceToken));
  expect(invite.status).toBe(201);
  const code = invite.body.referral.code as string;
  const join = await request(app)
    .post(`/api/reservations/${bobRes}/referral/join`)
    .set(auth(bobToken))
    .send({ code });
  expect(join.status).toBe(200);
  return { aliceRes, bobRes, code };
}

/** A live QR token for the shop's barber, as the barber's screen would show. */
async function qr(forBarberId = barberId, forShopId = shopId): Promise<string> {
  const { token } = await mintBarberToken(forBarberId, forShopId);
  return token;
}

beforeAll(async () => {
  const city = await prisma.city.create({ data: { name: "Referralville", slug: "referralville" } });
  const plan = await prisma.plan.create({
    data: { name: "Referral Plan", monthlyPrice: 10_000, features: "", isFeaturedTier: false },
  });
  const hours = Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    openMinute: 9 * 60,
    closeMinute: 20 * 60,
  })).filter((h) => h.weekday !== 5);
  const sub = {
    planId: plan.id,
    status: "ACTIVE",
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
  };

  const shop = await prisma.barbershop.create({
    data: {
      name: "Referral Cuts",
      description: "Runs the bring-a-friend offer.",
      address: "1 Referral Street",
      phone: "+9647500000010",
      cityId: city.id,
      chairCount: 5,
      isVisible: true,
      referralDiscount: DISCOUNT,
      services: { create: [{ name: "Cut", durationMin: 30, price: PRICE }] },
      openingHours: { create: hours },
      barbers: { create: [{ name: "Referral Barber", email: "referral.barber@test.dev" }] },
      subscription: { create: sub },
    },
    include: { services: true, barbers: true },
  });
  shopId = shop.id;
  serviceId = shop.services[0].id;
  barberId = shop.barbers[0].id;

  // A second shop, used to prove a QR only counts at the shop that issued it.
  const other = await prisma.barbershop.create({
    data: {
      name: "Other Cuts",
      description: "A different shop entirely.",
      address: "2 Other Street",
      phone: "+9647500000011",
      cityId: city.id,
      chairCount: 5,
      isVisible: true,
      referralDiscount: DISCOUNT,
      services: { create: [{ name: "Cut", durationMin: 30, price: PRICE }] },
      openingHours: { create: hours },
      barbers: { create: [{ name: "Other Barber", email: "other.barber@test.dev" }] },
      subscription: { create: sub },
    },
    include: { barbers: true },
  });
  otherShopId = other.id;
  otherBarberId = other.barbers[0].id;

  const alice = await login("alice.referral@test.dev");
  const bob = await login("bob.referral@test.dev");
  aliceToken = alice.token;
  aliceId = alice.id;
  bobToken = bob.token;
  bobId = bob.id;
});

describe("linkage: sharing and redeeming a code", () => {
  it("issues a code and is idempotent about it", async () => {
    await clearBookings();
    const res = await book(aliceToken, openDate(2), 10 * 60);

    const first = await request(app)
      .post(`/api/reservations/${res}/referral/invite`)
      .set(auth(aliceToken));
    expect(first.status).toBe(201);
    expect(first.body.referral.discountAmount).toBe(DISCOUNT);
    expect(first.body.referral.status).toBe("OPEN");

    // Tapping "invite a friend" twice must not mint a second code — otherwise
    // one booking could seed several pairs.
    const second = await request(app)
      .post(`/api/reservations/${res}/referral/invite`)
      .set(auth(aliceToken));
    expect(second.status).toBe(201);
    expect(second.body.referral.code).toBe(first.body.referral.code);
    expect(await prisma.referralPair.count({ where: { inviterReservationId: res } })).toBe(1);
  });

  it("refuses to issue a code at a shop that is not running the offer", async () => {
    await clearBookings();
    await prisma.barbershop.update({ where: { id: shopId }, data: { referralDiscount: 0 } });
    const res = await book(aliceToken, openDate(2), 10 * 60);
    const invite = await request(app)
      .post(`/api/reservations/${res}/referral/invite`)
      .set(auth(aliceToken));
    expect(invite.status).toBe(400);
    expect(invite.body.error.code).toBe("REFERRAL_NOT_AVAILABLE");
    await prisma.barbershop.update({
      where: { id: shopId },
      data: { referralDiscount: DISCOUNT },
    });
  });

  it("rejects a code used on the issuer's own booking", async () => {
    // The offer is "bring a friend". One person with two bookings is not a
    // friend, and a barber cannot tell two accounts apart at the chair.
    await clearBookings();
    const date = openDate(2);
    const first = await book(aliceToken, date, 10 * 60);
    const invite = await request(app)
      .post(`/api/reservations/${first}/referral/invite`)
      .set(auth(aliceToken));

    // Alice cancels and rebooks so she has a second live booking to try it on.
    await request(app).post(`/api/reservations/${first}/cancel`).set(auth(aliceToken));
    const second = await book(aliceToken, date, 12 * 60);
    const join = await request(app)
      .post(`/api/reservations/${second}/referral/join`)
      .set(auth(aliceToken))
      .send({ code: invite.body.referral.code });
    // Either guard is correct: self-use, or the cancelled inviter voiding it.
    expect(join.status).toBe(400);
    expect(["REFERRAL_SELF", "REFERRAL_CODE_INVALID"]).toContain(join.body.error.code);
  });

  it("rejects a code from a different barbershop", async () => {
    await clearBookings();
    const date = openDate(2);
    const aliceRes = await book(aliceToken, date, 10 * 60);
    const invite = await request(app)
      .post(`/api/reservations/${aliceRes}/referral/invite`)
      .set(auth(aliceToken));

    const bobElsewhere = await request(app)
      .post("/api/reservations")
      .set(auth(bobToken))
      .send({
        shopId: otherShopId,
        serviceId: (await prisma.service.findFirstOrThrow({ where: { shopId: otherShopId } })).id,
        date,
        startMinute: 11 * 60,
      });
    expect(bobElsewhere.status).toBe(201);

    const join = await request(app)
      .post(`/api/reservations/${bobElsewhere.body.reservation.id}/referral/join`)
      .set(auth(bobToken))
      .send({ code: invite.body.referral.code });
    expect(join.status).toBe(400);
    expect(join.body.error.code).toBe("REFERRAL_WRONG_SHOP");
  });

  it("rejects an unknown code", async () => {
    await clearBookings();
    const res = await book(bobToken, openDate(2), 10 * 60);
    const join = await request(app)
      .post(`/api/reservations/${res}/referral/join`)
      .set(auth(bobToken))
      .send({ code: "ZZZZZZ" });
    expect(join.status).toBe(400);
    expect(join.body.error.code).toBe("REFERRAL_CODE_INVALID");
  });

  it("lets only one friend claim a code", async () => {
    const { code } = await freshPair(); // Bob already joined
    const carol = await login("carol.referral@test.dev");
    const carolRes = await book(carol.token, openDate(2), 13 * 60);
    const join = await request(app)
      .post(`/api/reservations/${carolRes}/referral/join`)
      .set(auth(carol.token))
      .send({ code });
    expect(join.status).toBe(400);
    expect(join.body.error.code).toBe("REFERRAL_CODE_INVALID");
    await prisma.reservation.deleteMany({ where: { userId: carol.id } });
  });
});

describe("presence: scanning the barber's QR", () => {
  it("applies the discount to BOTH bookings only after both scan", async () => {
    const { aliceRes, bobRes } = await freshPair();

    // One scan is not enough — a code plus one person present would let a
    // no-show friend earn a discount.
    const first = await request(app)
      .post(`/api/reservations/${aliceRes}/referral/scan`)
      .set(auth(aliceToken))
      .send({ token: await qr() });
    expect(first.status).toBe(200);
    expect(first.body.discountApplied).toBe(false);
    expect(first.body.referral.youScanned).toBe(true);
    expect(first.body.referral.friendScanned).toBe(false);

    let rows = await prisma.reservation.findMany({ where: { id: { in: [aliceRes, bobRes] } } });
    expect(rows.every((r) => r.discountAmount === 0)).toBe(true);

    // Second scan completes the pair.
    const second = await request(app)
      .post(`/api/reservations/${bobRes}/referral/scan`)
      .set(auth(bobToken))
      .send({ token: await qr() });
    expect(second.status).toBe(200);
    expect(second.body.discountApplied).toBe(true);
    expect(second.body.referral.status).toBe("CONFIRMED");

    rows = await prisma.reservation.findMany({ where: { id: { in: [aliceRes, bobRes] } } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.discountAmount === DISCOUNT)).toBe(true);
    // `price` stays the original — the frozen-at-booking invariant holds.
    expect(rows.every((r) => r.price === PRICE)).toBe(true);
  });

  it("rejects an expired QR token", async () => {
    // The short TTL is the entire defence against a screenshot being sent to a
    // friend who is not at the shop.
    const { aliceRes } = await freshPair();
    const { token } = await mintBarberToken(barberId, shopId);
    await prisma.referralToken.update({
      where: { token },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const res = await request(app)
      .post(`/api/reservations/${aliceRes}/referral/scan`)
      .set(auth(aliceToken))
      .send({ token });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("QR_EXPIRED");
  });

  it("rejects a forged token", async () => {
    const { aliceRes } = await freshPair();
    const res = await request(app)
      .post(`/api/reservations/${aliceRes}/referral/scan`)
      .set(auth(aliceToken))
      .send({ token: "not-a-real-token-at-all" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("QR_EXPIRED");
  });

  it("rejects another shop's QR", async () => {
    // Being present somewhere is not being present HERE.
    const { aliceRes } = await freshPair();
    const res = await request(app)
      .post(`/api/reservations/${aliceRes}/referral/scan`)
      .set(auth(aliceToken))
      .send({ token: await qr(otherBarberId, otherShopId) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("REFERRAL_WRONG_SHOP");
  });

  it("refuses to scan before a friend has joined", async () => {
    await clearBookings();
    const res = await book(aliceToken, openDate(2), 10 * 60);
    await request(app).post(`/api/reservations/${res}/referral/invite`).set(auth(aliceToken));
    const scan = await request(app)
      .post(`/api/reservations/${res}/referral/scan`)
      .set(auth(aliceToken))
      .send({ token: await qr() });
    expect(scan.status).toBe(400);
    expect(scan.body.error.code).toBe("REFERRAL_INCOMPLETE");
  });

  it("does not discount twice when a scan is replayed", async () => {
    const { aliceRes, bobRes } = await freshPair();
    await request(app)
      .post(`/api/reservations/${aliceRes}/referral/scan`)
      .set(auth(aliceToken))
      .send({ token: await qr() });
    await request(app)
      .post(`/api/reservations/${bobRes}/referral/scan`)
      .set(auth(bobToken))
      .send({ token: await qr() });

    const replay = await request(app)
      .post(`/api/reservations/${bobRes}/referral/scan`)
      .set(auth(bobToken))
      .send({ token: await qr() });
    expect(replay.status).toBe(200);
    expect(replay.body.discountApplied).toBe(false);

    const rows = await prisma.reservation.findMany({ where: { id: { in: [aliceRes, bobRes] } } });
    expect(rows.every((r) => r.discountAmount === DISCOUNT)).toBe(true);
  });

  it("refuses a scan on someone else's booking", async () => {
    const { aliceRes } = await freshPair();
    const res = await request(app)
      .post(`/api/reservations/${aliceRes}/referral/scan`)
      .set(auth(bobToken))
      .send({ token: await qr() });
    expect(res.status).toBe(404);
  });
});

describe("the money", () => {
  it("charges the customer less and pays the barber less by the same amount", async () => {
    const { aliceRes, bobRes } = await freshPair();
    await request(app)
      .post(`/api/reservations/${aliceRes}/referral/scan`)
      .set(auth(aliceToken))
      .send({ token: await qr() });
    await request(app)
      .post(`/api/reservations/${bobRes}/referral/scan`)
      .set(auth(bobToken))
      .send({ token: await qr() });

    // Customer view: original price preserved, payable reduced.
    const mine = await request(app)
      .get("/api/reservations/mine?scope=upcoming")
      .set(auth(aliceToken));
    const booking = mine.body.reservations.find((r: { id: string }) => r.id === aliceRes);
    expect(booking.discountAmount).toBe(DISCOUNT);
    expect(booking.payableAmount).toBe(PRICE - DISCOUNT);
    expect(booking.service.price).toBe(PRICE);

    // Barber view: earnings are net of the discount they funded. Push the
    // bookings into the past so they count as completed cuts.
    // Distinct slots: both are assigned to the same barber, and the
    // no_barber_overlap exclusion constraint rightly rejects two active
    // bookings sharing one barber and one time range.
    const past = Date.now() - 3 * 86_400_000;
    await prisma.reservation.update({
      where: { id: aliceRes },
      data: {
        status: "CONFIRMED",
        startsAt: new Date(past),
        endsAt: new Date(past + 30 * 60_000),
      },
    });
    await prisma.reservation.update({
      where: { id: bobRes },
      data: {
        status: "CONFIRMED",
        startsAt: new Date(past + 60 * 60_000),
        endsAt: new Date(past + 90 * 60_000),
      },
    });
    const barberLogin = await login("referral.barber@test.dev");
    const stats = await request(app).get("/api/barber/stats").set(auth(barberLogin.token));
    expect(stats.status).toBe(200);
    expect(stats.body.stats.totalCuts).toBe(2);
    expect(stats.body.stats.totalEarnings).toBe(2 * (PRICE - DISCOUNT));
  });

  it("snapshots the amount so a later admin change cannot rewrite it", async () => {
    const { aliceRes, bobRes } = await freshPair();
    // Admin retunes the promo after the pair was formed.
    await prisma.barbershop.update({ where: { id: shopId }, data: { referralDiscount: 9_000 } });

    await request(app)
      .post(`/api/reservations/${aliceRes}/referral/scan`)
      .set(auth(aliceToken))
      .send({ token: await qr() });
    await request(app)
      .post(`/api/reservations/${bobRes}/referral/scan`)
      .set(auth(bobToken))
      .send({ token: await qr() });

    const rows = await prisma.reservation.findMany({ where: { id: { in: [aliceRes, bobRes] } } });
    // They get what they were promised when they paired, not the new figure.
    expect(rows.every((r) => r.discountAmount === DISCOUNT)).toBe(true);
    await prisma.barbershop.update({
      where: { id: shopId },
      data: { referralDiscount: DISCOUNT },
    });
  });
});

describe("bookings that fall through", () => {
  it("voids the pair when one person cancels", async () => {
    const { aliceRes, bobRes } = await freshPair();
    const cancel = await request(app)
      .post(`/api/reservations/${aliceRes}/cancel`)
      .set(auth(aliceToken));
    expect(cancel.status).toBe(200);

    const pair = await prisma.referralPair.findFirstOrThrow({
      where: { inviterReservationId: aliceRes },
    });
    expect(pair.status).toBe("VOID");

    // The friend who still turned up cannot claim a discount on their own.
    const scan = await request(app)
      .post(`/api/reservations/${bobRes}/referral/scan`)
      .set(auth(bobToken))
      .send({ token: await qr() });
    expect(scan.status).toBe(400);
    expect(scan.body.error.code).toBe("REFERRAL_INCOMPLETE");

    const bob = await prisma.reservation.findUniqueOrThrow({ where: { id: bobRes } });
    expect(bob.discountAmount).toBe(0);
  });
});

describe("the barber's QR endpoint", () => {
  it("issues a short-lived token bound to the barber's shop", async () => {
    await prisma.barbershop.update({
      where: { id: shopId },
      data: { referralDiscount: DISCOUNT },
    });
    const barberLogin = await login("referral.barber@test.dev");
    const res = await request(app)
      .get("/api/barber/referral-token")
      .set(auth(barberLogin.token));
    expect(res.status).toBe(200);
    expect(res.body.discountAmount).toBe(DISCOUNT);
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // Short enough that a screenshot is useless before it can travel.
    expect(res.body.ttlMs).toBeLessThanOrEqual(120_000);

    const stored = await prisma.referralToken.findUniqueOrThrow({
      where: { token: res.body.token },
    });
    expect(stored.shopId).toBe(shopId);
    expect(stored.barberId).toBe(barberId);
  });

  it("refuses a customer who is not a barber", async () => {
    const res = await request(app).get("/api/barber/referral-token").set(auth(aliceToken));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NOT_A_BARBER");
  });
});
