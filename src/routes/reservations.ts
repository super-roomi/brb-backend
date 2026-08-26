import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireUser } from "../middleware/auth.js";
import { validate, parsed } from "../middleware/validate.js";
import {
  cancelReservation,
  createReservation,
  reservationInclude,
} from "../services/booking.js";
import {
  createInvite,
  joinInvite,
  pairForReservation,
  recordScan,
} from "../services/referral.js";
import { isValidDateString } from "../lib/time.js";
import { parseLang, localize, type Lang } from "../lib/localize.js";

export const reservationsRouter = Router();
reservationsRouter.use(requireUser);

const createSchema = z.object({
  shopId: z.string(),
  serviceId: z.string(),
  date: z.string().refine(isValidDateString, "Expected YYYY-MM-DD"),
  startMinute: z.number().int().min(0).max(24 * 60 - 1),
  // Omit or send null for "any available barber".
  barberId: z.string().optional(),
});

reservationsRouter.post("/", validate(createSchema), async (req, res) => {
  const body = parsed<z.infer<typeof createSchema>>(req);
  const reservation = await createReservation({ userId: req.auth!.userId, ...body });
  res.status(201).json({ reservation: serialize(reservation, parseLang(req.query.lang)) });
});

const listSchema = z.object({ scope: z.enum(["upcoming", "past"]).default("upcoming") });

reservationsRouter.get("/mine", validate(listSchema, "query"), async (req, res) => {
  const { scope } = parsed<z.infer<typeof listSchema>>(req);
  const now = new Date();
  const reservations = await prisma.reservation.findMany({
    where: {
      userId: req.auth!.userId,
      // Upcoming = future and still live (pending or confirmed). Everything
      // else — past, cancelled, declined — is history.
      ...(scope === "upcoming"
        ? { endsAt: { gte: now }, status: { in: ["PENDING", "CONFIRMED"] } }
        : { OR: [{ endsAt: { lt: now } }, { status: { in: ["CANCELLED", "DECLINED"] } }] }),
    },
    include: reservationInclude,
    orderBy: { startsAt: scope === "upcoming" ? "asc" : "desc" },
    take: 100,
  });
  const lang = parseLang(req.query.lang);
  res.json({ reservations: reservations.map((r) => serialize(r, lang)) });
});

reservationsRouter.post("/:id/cancel", async (req, res) => {
  const reservation = await cancelReservation(req.auth!.userId, req.params.id);
  res.json({ reservation: serialize(reservation, parseLang(req.query.lang)) });
});

// ---- Referral ("bring a friend") ----
//
// Earning the discount takes two independent proofs, so it takes two steps that
// cannot substitute for each other: redeeming a code links the two bookings,
// and scanning the barber's QR proves both people are actually at the shop.
// See services/referral.ts.

// The caller's referral state for one booking (null when there is none).
reservationsRouter.get("/:id/referral", async (req, res) => {
  const pair = await pairForReservation(req.auth!.userId, req.params.id);
  res.json({ referral: pair });
});

// Issue a code to share with a friend. Idempotent — repeated taps return the
// same code rather than minting more.
reservationsRouter.post("/:id/referral/invite", async (req, res) => {
  const pair = await createInvite(req.auth!.userId, req.params.id);
  res.status(201).json({ referral: pair });
});

const joinSchema = z.object({ code: z.string().trim().min(4).max(12) });

// Redeem a friend's code against this booking. Links only — no discount yet.
reservationsRouter.post("/:id/referral/join", validate(joinSchema), async (req, res) => {
  const { code } = parsed<z.infer<typeof joinSchema>>(req);
  const pair = await joinInvite(req.auth!.userId, req.params.id, code);
  res.json({ referral: pair });
});

const scanSchema = z.object({ token: z.string().trim().min(10).max(200) });

// Record a scan of the barber's QR. The discount lands when the second person
// scans, applied to both bookings at once.
reservationsRouter.post("/:id/referral/scan", validate(scanSchema), async (req, res) => {
  const { token } = parsed<z.infer<typeof scanSchema>>(req);
  const result = await recordScan(req.auth!.userId, req.params.id, token);
  res.json({ referral: result.pair, discountApplied: result.discountApplied });
});

type Loaded = Awaited<ReturnType<typeof cancelReservation>>;

function serialize(r: Loaded, lang: Lang) {
  const completed = r.status === "CONFIRMED" && r.endsAt < new Date();
  return {
    id: r.id,
    status: completed ? "COMPLETED" : r.status,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    // `price` stays the original; these two say what the referral took off and
    // what is actually due at the chair, so the app never re-derives the sum.
    discountAmount: r.discountAmount,
    payableAmount: Math.max(0, r.price - r.discountAmount),
    // Localize content names; strip the Ar/Ckb columns from the payload.
    shop: {
      id: r.shop.id,
      name: localize(lang, r.shop.name, r.shop.nameAr, r.shop.nameCkb),
      address: r.shop.address,
      imageUrl: r.shop.imageUrl,
      utcOffsetMinutes: r.shop.utcOffsetMinutes,
      referralDiscount: r.shop.referralDiscount,
    },
    service: {
      id: r.service.id,
      name: localize(lang, r.service.name, r.service.nameAr, r.service.nameCkb),
      durationMin: r.service.durationMin,
      price: r.service.price,
    },
    barber: r.barber
      ? { id: r.barber.id, name: localize(lang, r.barber.name, r.barber.nameAr, r.barber.nameCkb) }
      : null,
  };
}
