import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
import { signAdminToken } from "../lib/jwt.js";
import { requireAdmin } from "../middleware/auth.js";
import { validate, parsed } from "../middleware/validate.js";
import { isShopLive, adminCancelReservation } from "../services/booking.js";
import { notifyUser } from "../lib/notify.js";
import { bookingCancelledByShop } from "../lib/notificationMessages.js";
import { adminLoginLimiter } from "../middleware/rateLimit.js";
import { addMonths } from "../lib/time.js";
import { audit } from "../lib/audit.js";
import { referralDealStarted } from "../lib/notificationMessages.js";
import { localize } from "../lib/localize.js";
import { logger } from "../lib/logger.js";
import { broadcastToAllUsers, isBroadcastRunning } from "../services/broadcast.js";
import { STANDARD_SERVICE } from "../lib/standardService.js";

export const adminRouter = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });

adminRouter.post("/login", adminLoginLimiter, validate(loginSchema), async (req, res) => {
  const { email, password } = parsed<z.infer<typeof loginSchema>>(req);
  const admin = await prisma.adminUser.findUnique({ where: { email } });
  // Same error for unknown email and wrong password — no account probing.
  if (!admin || !(await bcrypt.compare(password, admin.passwordHash))) {
    throw ApiError.unauthorized("Invalid credentials", "BAD_CREDENTIALS");
  }
  // A disabled admin's row is kept so the audit trail stays resolvable, but the
  // credential must stop working. Same generic message — don't reveal that the
  // account exists but is off.
  if (!admin.isActive) {
    throw ApiError.unauthorized("Invalid credentials", "BAD_CREDENTIALS");
  }
  // Signed with the dedicated admin secret and audience (see lib/jwt.ts), so a
  // customer token can never satisfy requireAdmin and vice versa.
  res.json({
    accessToken: signAdminToken(admin.id),
    admin: { id: admin.id, email: admin.email, name: admin.name },
  });
});

adminRouter.use(requireAdmin);

adminRouter.get("/summary", async (_req, res) => {
  const now = new Date();
  const [shops, liveShops, users, upcoming, plans] = await Promise.all([
    prisma.barbershop.count(),
    prisma.barbershop.count({
      where: {
        isVisible: true,
        subscription: { is: { status: "ACTIVE", currentPeriodEnd: { gt: now } } },
      },
    }),
    prisma.user.count(),
    prisma.reservation.count({ where: { status: "CONFIRMED", startsAt: { gte: now } } }),
    prisma.plan.count({ where: { isActive: true } }),
  ]);
  res.json({ shops, liveShops, users, upcomingReservations: upcoming, plans });
});

// ---- Cities ----

adminRouter.get("/cities", async (_req, res) => {
  const cities = await prisma.city.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { shops: true } } },
  });
  res.json({
    cities: cities.map((c) => ({ id: c.id, name: c.name, slug: c.slug, shopCount: c._count.shops })),
  });
});

const citySchema = z.object({ name: z.string().trim().min(2).max(60) });

adminRouter.post("/cities", validate(citySchema), async (req, res) => {
  const { name } = parsed<z.infer<typeof citySchema>>(req);
  const slug = name.toLowerCase().replace(/\s+/g, "-");
  const city = await prisma.city.create({ data: { name, slug } });
  audit(req, { action: "city.create", targetType: "City", targetId: city.id, detail: { name } });
  res.status(201).json({ city });
});

const slugify = (name: string) => name.toLowerCase().replace(/\s+/g, "-");

// Rename a city. Both name and slug are unique; regenerate the slug from the new
// name so app-facing links stay consistent. A typo used to be permanent.
adminRouter.patch("/cities/:id", validate(citySchema), async (req, res) => {
  const { name } = parsed<z.infer<typeof citySchema>>(req);
  const existing = await prisma.city.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound("City not found");
  const city = await prisma.city
    .update({ where: { id: existing.id }, data: { name, slug: slugify(name) } })
    .catch(() => {
      throw ApiError.conflict("Another city already has that name", "CITY_EXISTS");
    });
  audit(req, {
    action: "city.update",
    targetType: "City",
    targetId: city.id,
    detail: { from: existing.name, to: name },
  });
  res.json({ city });
});

// Delete a city — only when nothing references it. A city with shops must be
// merged (below), not deleted, or its shops would be orphaned.
adminRouter.delete("/cities/:id", async (req, res) => {
  const city = await prisma.city.findUnique({
    where: { id: req.params.id },
    include: { _count: { select: { shops: true } } },
  });
  if (!city) throw ApiError.notFound("City not found");
  if (city._count.shops > 0) {
    throw ApiError.badRequest(
      "This city still has shops. Merge it into another city first.",
      "CITY_HAS_SHOPS",
    );
  }
  await prisma.city.delete({ where: { id: city.id } });
  audit(req, { action: "city.delete", targetType: "City", targetId: city.id, detail: { name: city.name } });
  res.json({ ok: true });
});

// Merge one city into another: reassign every shop, then delete the now-empty
// source. This is how a duplicate or misspelled city gets fixed without
// orphaning its shops — the reassignment and delete are one transaction so a
// failure can't leave shops pointing at a city that is about to vanish.
const mergeSchema = z.object({ intoId: z.string() });
adminRouter.post("/cities/:id/merge", validate(mergeSchema), async (req, res) => {
  const { intoId } = parsed<z.infer<typeof mergeSchema>>(req);
  if (intoId === req.params.id) {
    throw ApiError.badRequest("Can't merge a city into itself", "CITY_MERGE_SELF");
  }
  const [source, target] = await Promise.all([
    prisma.city.findUnique({ where: { id: req.params.id }, include: { _count: { select: { shops: true } } } }),
    prisma.city.findUnique({ where: { id: intoId } }),
  ]);
  if (!source) throw ApiError.notFound("City not found");
  if (!target) throw ApiError.badRequest("Target city not found", "CITY_MERGE_TARGET");

  const moved = source._count.shops;
  await prisma.$transaction([
    prisma.barbershop.updateMany({ where: { cityId: source.id }, data: { cityId: target.id } }),
    prisma.city.delete({ where: { id: source.id } }),
  ]);
  audit(req, {
    action: "city.merge",
    targetType: "City",
    targetId: target.id,
    detail: { from: source.name, into: target.name, shopsMoved: moved },
  });
  res.json({ ok: true, shopsMoved: moved });
});

// ---- Barbershops ----

const hoursSchema = z
  .array(
    z.object({
      weekday: z.number().int().min(0).max(6),
      openMinute: z.number().int().min(0).max(1439),
      closeMinute: z.number().int().min(1).max(1440),
    }).refine((h) => h.closeMinute > h.openMinute, "closeMinute must be after openMinute"),
  )
  .max(7)
  .refine(
    (hs) => new Set(hs.map((h) => h.weekday)).size === hs.length,
    "Duplicate weekday",
  );

// Optional Ar/Ckb translations for a short content field. "" is coerced to
// null (see emptyToNull) so a cleared field is stored as absent.
const trShort = z.string().trim().max(80).nullable().optional();
const trLong = z.string().trim().max(2000).nullable().optional();

const serviceSchema = z.object({
  id: z.string().optional(), // present = update existing
  name: z.string().trim().min(2).max(80),
  nameAr: trShort,
  nameCkb: trShort,
  durationMin: z.number().int().min(5).max(480),
  price: z.number().int().min(0),
  isActive: z.boolean().default(true),
});

const barberSchema = z.object({
  id: z.string().optional(), // present = update existing
  name: z.string().trim().min(2).max(60),
  nameAr: trShort,
  nameCkb: trShort,
  // Lowercase at the boundary. A barber signs into the mobile app with this
  // Google account, and the barber-identity lookup is exact string equality
  // against the User's (already-lowercased) email — so a mixed-case stored
  // email would silently lock the barber out of their dashboard.
  email: z.string().trim().toLowerCase().email().max(120),
  isActive: z.boolean().default(true),
  // Barbers normally toggle this themselves in the app; exposing it here lets an
  // admin diagnose "why is this booking stuck PENDING" from the panel. Optional
  // so an update that omits it doesn't clobber the barber's own choice.
  autoApprove: z.boolean().optional(),
});

// Empty string clears a social link; otherwise must be a URL.
const socialUrl = z
  .union([z.string().url().max(500), z.literal("")])
  .nullable()
  .optional();

const shopBase = z.object({
  name: z.string().trim().min(2).max(80),
  nameAr: trShort,
  nameCkb: trShort,
  description: z.string().trim().min(10).max(2000),
  descriptionAr: trLong,
  descriptionCkb: trLong,
  address: z.string().trim().min(5).max(200),
  phone: z.string().trim().min(8).max(20),
  imageUrl: z.string().url().max(500).nullable().optional(),
  cityId: z.string(),
  chairCount: z.number().int().min(1).max(50),
  // Grace period (minutes) enforced between consecutive bookings per barber.
  bufferMin: z.number().int().min(0).max(180).default(0),
  utcOffsetMinutes: z.number().int().min(-720).max(840).default(180),
  // "Bring a friend" promo: flat IQD off EACH of two paired bookings, funded by
  // the barber. 0 turns it off for this shop, which is the default — a shop only
  // runs the promo once an admin deliberately sets an amount.
  referralDiscount: z.number().int().min(0).max(1_000_000).default(0),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  locationLabel: trShort,
  locationLabelAr: trShort,
  locationLabelCkb: trShort,
  instagramUrl: socialUrl,
  facebookUrl: socialUrl,
  tiktokUrl: socialUrl,
  snapchatUrl: socialUrl,
  openingHours: hoursSchema,
  services: z.array(serviceSchema).min(1).max(50),
  barbers: z.array(barberSchema).max(50).default([]),
});

// "" → null so cleared links are stored as absent, not empty strings.
const emptyToNull = (v: string | null | undefined) =>
  v === undefined ? undefined : v === "" ? null : v;

// Paginated, but defaults to a page large enough that the existing panel (which
// renders the whole list and filters client-side) keeps working unchanged.
// `pageSize=all` is deliberately absent: an unbounded scan with two _count
// subqueries per row is exactly what stops being survivable as the platform grows.
const shopListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(200),
});

adminRouter.get("/shops", validate(shopListSchema, "query"), async (req, res) => {
  const q = parsed<z.infer<typeof shopListSchema>>(req);
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [total, shops, recentGroups] = await Promise.all([
    prisma.barbershop.count(),
    prisma.barbershop.findMany({
      include: {
        city: { select: { id: true, name: true } },
        subscription: { include: { plan: { select: { id: true, name: true, isFeaturedTier: true } } } },
        _count: { select: { reservations: true, reviews: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    // Bookings in the last 30 days, per shop. A lifetime count can't tell a
    // thriving shop from one that stopped getting bookings a month ago; this
    // can. One grouped query rather than a per-row subquery.
    prisma.reservation.groupBy({
      by: ["shopId"],
      where: { createdAt: { gte: since } },
      _count: true,
    }),
  ]);
  const recentByShop = new Map(recentGroups.map((g) => [g.shopId, g._count]));
  res.json({
    page: q.page,
    pageSize: q.pageSize,
    total,
    shops: shops.map((s) => ({
      id: s.id,
      name: s.name,
      city: s.city,
      address: s.address,
      isVisible: s.isVisible,
      isLive: isShopLive(s),
      referralDiscount: s.referralDiscount,
      ratingAvg: s.ratingAvg,
      ratingCount: s.ratingCount,
      reservationCount: s._count.reservations,
      recentReservationCount: recentByShop.get(s.id) ?? 0,
      subscription: s.subscription
        ? {
            plan: s.subscription.plan,
            status: s.subscription.status,
            currentPeriodEnd: s.subscription.currentPeriodEnd.toISOString(),
            expired: s.subscription.currentPeriodEnd <= new Date(),
          }
        : null,
      createdAt: s.createdAt.toISOString(),
    })),
  });
});

adminRouter.get("/shops/:id", async (req, res) => {
  const shop = await prisma.barbershop.findUnique({
    where: { id: req.params.id },
    include: {
      city: true,
      services: { orderBy: { price: "asc" } },
      openingHours: { orderBy: { weekday: "asc" } },
      barbers: { orderBy: { name: "asc" } },
      subscription: { include: { plan: true } },
    },
  });
  if (!shop) throw ApiError.notFound("Barbershop not found");
  res.json({ shop });
});

adminRouter.post("/shops", validate(shopBase), async (req, res) => {
  const body = parsed<z.infer<typeof shopBase>>(req);
  const city = await prisma.city.findUnique({ where: { id: body.cityId } });
  if (!city) throw ApiError.badRequest("Unknown city", "UNKNOWN_CITY");

  await assertBarberEmailsFree(body.barbers ?? []);

  const shop = await prisma.barbershop
    .create({
      data: {
        name: body.name,
        nameAr: emptyToNull(body.nameAr) ?? null,
        nameCkb: emptyToNull(body.nameCkb) ?? null,
        description: body.description,
        descriptionAr: emptyToNull(body.descriptionAr) ?? null,
        descriptionCkb: emptyToNull(body.descriptionCkb) ?? null,
        address: body.address,
        phone: body.phone,
        imageUrl: body.imageUrl ?? null,
        cityId: body.cityId,
        chairCount: body.chairCount,
        bufferMin: body.bufferMin,
        utcOffsetMinutes: body.utcOffsetMinutes,
        referralDiscount: body.referralDiscount,
        latitude: body.latitude ?? null,
        longitude: body.longitude ?? null,
        locationLabel: emptyToNull(body.locationLabel) ?? null,
        locationLabelAr: emptyToNull(body.locationLabelAr) ?? null,
        locationLabelCkb: emptyToNull(body.locationLabelCkb) ?? null,
        instagramUrl: emptyToNull(body.instagramUrl) ?? null,
        facebookUrl: emptyToNull(body.facebookUrl) ?? null,
        tiktokUrl: emptyToNull(body.tiktokUrl) ?? null,
        snapchatUrl: emptyToNull(body.snapchatUrl) ?? null,
        isVisible: false, // new shops start hidden until the admin flips them on
        services: {
          create: [
            // Every shop carries the standard combo (quick booking preselects
            // it); the admin's own services follow.
            {
              name: STANDARD_SERVICE.name,
              nameAr: STANDARD_SERVICE.nameAr,
              nameCkb: STANDARD_SERVICE.nameCkb,
              durationMin: STANDARD_SERVICE.durationMin,
              price: STANDARD_SERVICE.price,
              isActive: true,
              isStandard: true,
            },
            ...body.services.map((s) => ({
              name: s.name,
              nameAr: emptyToNull(s.nameAr) ?? null,
              nameCkb: emptyToNull(s.nameCkb) ?? null,
              durationMin: s.durationMin,
              price: s.price,
              isActive: s.isActive,
            })),
          ],
        },
        openingHours: { create: body.openingHours },
        barbers: {
          create: (body.barbers ?? []).map((b) => ({
            name: b.name,
            nameAr: emptyToNull(b.nameAr) ?? null,
            nameCkb: emptyToNull(b.nameCkb) ?? null,
            email: b.email,
            isActive: b.isActive,
            autoApprove: b.autoApprove ?? false,
          })),
        },
      },
    })
    .catch(rethrowBarberEmailConflict);
  audit(req, {
    action: "shop.create",
    targetType: "Barbershop",
    targetId: shop.id,
    detail: { name: body.name, cityId: body.cityId },
  });
  res.status(201).json({ shop: { id: shop.id } });
});

// The pre-check below narrows most conflicts to a friendly 409, but two admins
// saving the same new email concurrently can still slip past it and hit the DB
// unique constraint. Translate that P2002 into the same 409 instead of a 500.
function rethrowBarberEmailConflict(e: unknown): never {
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === "P2002" &&
    String(e.meta?.target ?? "").includes("email")
  ) {
    throw ApiError.conflict("That barber email is already in use", "BARBER_EMAIL_TAKEN");
  }
  throw e;
}

// A barber email must be unique across the whole platform (it is a login).
async function assertBarberEmailsFree(
  barbers: { id?: string; email: string }[],
  shopId?: string,
) {
  const emails = barbers.map((b) => b.email);
  if (new Set(emails).size !== emails.length) {
    throw ApiError.badRequest("Duplicate barber email in this shop", "DUP_BARBER_EMAIL");
  }
  const clashes = await prisma.barber.findMany({
    where: { email: { in: emails } },
  });
  for (const clash of clashes) {
    const submitted = barbers.find((b) => b.email === clash.email);
    // OK when it is the same barber being edited in the same shop.
    if (!(submitted?.id === clash.id && clash.shopId === shopId)) {
      throw ApiError.conflict(
        `Email ${clash.email} already belongs to another barber`,
        "BARBER_EMAIL_TAKEN",
      );
    }
  }
}

adminRouter.patch("/shops/:id", validate(shopBase.partial()), async (req, res) => {
  const body = parsed<z.infer<ReturnType<typeof shopBase.partial>>>(req);
  const existing = await prisma.barbershop.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound("Barbershop not found");
  if (body.barbers) await assertBarberEmailsFree(body.barbers, existing.id);

  await prisma.$transaction(async (tx) => {
    await tx.barbershop.update({
      where: { id: existing.id },
      data: {
        name: body.name,
        nameAr: emptyToNull(body.nameAr),
        nameCkb: emptyToNull(body.nameCkb),
        description: body.description,
        descriptionAr: emptyToNull(body.descriptionAr),
        descriptionCkb: emptyToNull(body.descriptionCkb),
        address: body.address,
        phone: body.phone,
        imageUrl: body.imageUrl,
        cityId: body.cityId,
        chairCount: body.chairCount,
        bufferMin: body.bufferMin,
        utcOffsetMinutes: body.utcOffsetMinutes,
        referralDiscount: body.referralDiscount,
        latitude: body.latitude,
        longitude: body.longitude,
        locationLabel: emptyToNull(body.locationLabel),
        locationLabelAr: emptyToNull(body.locationLabelAr),
        locationLabelCkb: emptyToNull(body.locationLabelCkb),
        instagramUrl: emptyToNull(body.instagramUrl),
        facebookUrl: emptyToNull(body.facebookUrl),
        tiktokUrl: emptyToNull(body.tiktokUrl),
        snapchatUrl: emptyToNull(body.snapchatUrl),
      },
    });
    if (body.openingHours) {
      await tx.openingHour.deleteMany({ where: { shopId: existing.id } });
      await tx.openingHour.createMany({
        data: body.openingHours.map((h) => ({ ...h, shopId: existing.id })),
      });
    }
    if (body.services) {
      // Update by id when given; create otherwise. Services with reservations
      // are never deleted — deactivate instead. The standard combo is never
      // deactivated even if the payload omits it (quick booking relies on it).
      const keptIds = body.services.filter((s) => s.id).map((s) => s.id!);
      await tx.service.updateMany({
        where: { shopId: existing.id, id: { notIn: keptIds }, isStandard: false },
        data: { isActive: false },
      });
      for (const s of body.services) {
        if (s.id) {
          // Scope by shopId so a crafted payload can't edit another shop's
          // service by id. updateMany (not update) lets us match on both.
          await tx.service.updateMany({
            where: { id: s.id, shopId: existing.id },
            data: {
              name: s.name,
              nameAr: emptyToNull(s.nameAr),
              nameCkb: emptyToNull(s.nameCkb),
              durationMin: s.durationMin,
              price: s.price,
              isActive: s.isActive,
            },
          });
        } else {
          await tx.service.create({
            data: {
              shopId: existing.id,
              name: s.name,
              nameAr: emptyToNull(s.nameAr) ?? null,
              nameCkb: emptyToNull(s.nameCkb) ?? null,
              durationMin: s.durationMin,
              price: s.price,
              isActive: s.isActive,
            },
          });
        }
      }
    }
    if (body.barbers) {
      // Same pattern as services: update by id, create new ones, deactivate
      // omitted ones (never hard-delete — they own reservation history).
      const keptIds = body.barbers.filter((b) => b.id).map((b) => b.id!);
      await tx.barber.updateMany({
        where: { shopId: existing.id, id: { notIn: keptIds } },
        data: { isActive: false },
      });
      for (const b of body.barbers) {
        if (b.id) {
          // Scope by shopId (see services above): no cross-shop id edits.
          await tx.barber.updateMany({
            where: { id: b.id, shopId: existing.id },
            data: {
              name: b.name,
              nameAr: emptyToNull(b.nameAr),
              nameCkb: emptyToNull(b.nameCkb),
              email: b.email,
              isActive: b.isActive,
              // Only when the payload carries it — undefined leaves it as is.
              autoApprove: b.autoApprove,
            },
          });
        } else {
          await tx.barber.create({
            data: {
              shopId: existing.id,
              name: b.name,
              nameAr: emptyToNull(b.nameAr) ?? null,
              nameCkb: emptyToNull(b.nameCkb) ?? null,
              email: b.email,
              isActive: b.isActive,
              autoApprove: b.autoApprove ?? false,
            },
          });
        }
      }
    }
  }).catch(rethrowBarberEmailConflict);
  audit(req, {
    action: "shop.update",
    targetType: "Barbershop",
    targetId: existing.id,
    // Field names only — the full payload would bloat the trail and copy
    // customer-adjacent content into it for no investigative benefit.
    detail: { fields: Object.keys(body) },
  });

  // A shop "starting a deal": the promo just went from off to on. Tell
  // customers — but only about a shop they can actually book (live), and
  // fire-and-forget so a slow broadcast never holds up the admin's save.
  const startedDeal =
    existing.referralDiscount === 0 &&
    body.referralDiscount !== undefined &&
    body.referralDiscount > 0;
  if (startedDeal) {
    void announceReferralDeal(existing.id).catch((err) =>
      logger.error({ err, shopId: existing.id }, "referral deal announcement failed"),
    );
  }

  res.json({ ok: true });
});

// Announce a shop's newly-started bring-a-friend deal to every customer. Feed
// rows are localized per user; the push nudge uses the default language. No-op
// if the shop is no longer live, the promo was cleared again, or another
// broadcast is mid-flight (the deal simply isn't announced this time).
async function announceReferralDeal(shopId: string): Promise<void> {
  const shop = await prisma.barbershop.findUnique({
    where: { id: shopId },
    include: { subscription: true },
  });
  if (!shop || !isShopLive(shop) || shop.referralDiscount <= 0) return;
  if (isBroadcastRunning()) return;

  const amount = shop.referralDiscount;
  const dflt = referralDealStarted("en", {
    shop: shop.name,
    amount,
    lang: "en",
  });
  await broadcastToAllUsers({
    type: "REFERRAL_DEAL",
    title: dflt.title,
    body: dflt.body,
    data: { type: "REFERRAL_DEAL", shopId: shop.id },
    build: (lang) =>
      referralDealStarted(lang, {
        shop: localize(lang, shop.name, shop.nameAr, shop.nameCkb),
        amount,
        lang,
      }),
  });
}

const visibilitySchema = z.object({ isVisible: z.boolean() });

adminRouter.patch("/shops/:id/visibility", validate(visibilitySchema), async (req, res) => {
  const { isVisible } = parsed<z.infer<typeof visibilitySchema>>(req);
  const shop = await prisma.barbershop
    .update({ where: { id: req.params.id }, data: { isVisible } })
    .catch(() => null);
  if (!shop) throw ApiError.notFound("Barbershop not found");
  audit(req, {
    action: "shop.visibility",
    targetType: "Barbershop",
    targetId: shop.id,
    detail: { isVisible },
  });
  res.json({ id: shop.id, isVisible: shop.isVisible });
});

// ---- Plans ----

adminRouter.get("/plans", async (_req, res) => {
  const now = new Date();
  const [plans, activeGroups] = await Promise.all([
    prisma.plan.findMany({
      orderBy: { monthlyPrice: "asc" },
      // Raw count of every subscription row that references the plan. This is
      // what the delete guard cares about: the database's foreign key blocks a
      // delete while ANY subscription points here, cancelled ones included.
      include: { _count: { select: { subscriptions: true } } },
    }),
    // Paying subscribers: ACTIVE and not yet expired. A cancelled or lapsed row
    // still counts under _count above but must not inflate this figure — it is
    // the number an operator prices against.
    prisma.subscription.groupBy({
      by: ["planId"],
      where: { status: "ACTIVE", currentPeriodEnd: { gt: now } },
      _count: true,
    }),
  ]);
  const activeByPlan = new Map(activeGroups.map((g) => [g.planId, g._count]));
  res.json({
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      monthlyPrice: p.monthlyPrice,
      features: p.features,
      isFeaturedTier: p.isFeaturedTier,
      isActive: p.isActive,
      // Total rows (drives the delete guard); active subscribers (the real one).
      subscriberCount: p._count.subscriptions,
      activeSubscriberCount: activeByPlan.get(p.id) ?? 0,
    })),
  });
});

const planSchema = z.object({
  name: z.string().trim().min(2).max(40),
  monthlyPrice: z.number().int().min(0),
  features: z.string().trim().max(2000).default(""),
  isFeaturedTier: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

adminRouter.post("/plans", validate(planSchema), async (req, res) => {
  const body = parsed<z.infer<typeof planSchema>>(req);
  const plan = await prisma.plan.create({ data: body });
  audit(req, {
    action: "plan.create",
    targetType: "Plan",
    targetId: plan.id,
    detail: { name: body.name, monthlyPrice: body.monthlyPrice },
  });
  res.status(201).json({ plan });
});

adminRouter.patch("/plans/:id", validate(planSchema.partial()), async (req, res) => {
  const body = parsed<z.infer<ReturnType<typeof planSchema.partial>>>(req);
  const plan = await prisma.plan
    .update({ where: { id: req.params.id }, data: body })
    .catch(() => null);
  if (!plan) throw ApiError.notFound("Plan not found");
  // Pricing changes are the ones most likely to be questioned later, so record
  // the new values rather than just the field names.
  audit(req, { action: "plan.update", targetType: "Plan", targetId: plan.id, detail: body });
  res.json({ plan });
});

// Hard-delete a plan. Refused while any subscription (past or present)
// references it — deactivate it instead to keep billing history intact.
adminRouter.delete("/plans/:id", async (req, res) => {
  const inUse = await prisma.subscription.count({ where: { planId: req.params.id } });
  if (inUse > 0) {
    throw ApiError.conflict(
      "This plan is used by one or more shops. Deactivate it instead of deleting.",
      "PLAN_IN_USE",
    );
  }
  const deleted = await prisma.plan.delete({ where: { id: req.params.id } }).catch(() => null);
  if (!deleted) throw ApiError.notFound("Plan not found");
  audit(req, {
    action: "plan.delete",
    targetType: "Plan",
    targetId: deleted.id,
    detail: { name: deleted.name, monthlyPrice: deleted.monthlyPrice },
  });
  res.json({ ok: true });
});

// ---- Barber of the Week ----

// Eligible pool: shops live in the app AND on a featured-tier plan.
function botwEligibleWhere(now: Date) {
  return {
    isVisible: true,
    subscription: {
      is: { status: "ACTIVE", currentPeriodEnd: { gt: now }, plan: { isFeaturedTier: true } },
    },
  } as const;
}

adminRouter.get("/barber-of-week", async (_req, res) => {
  const now = new Date();
  const eligible = await prisma.barbershop.findMany({
    where: botwEligibleWhere(now),
    include: {
      city: { select: { name: true } },
      subscription: { select: { plan: { select: { name: true, monthlyPrice: true } } } },
    },
    orderBy: [{ ratingAvg: "desc" }, { ratingCount: "desc" }],
  });

  const current = eligible
    .filter((s) => s.botwRank != null)
    .sort((a, b) => (a.botwRank! - b.botwRank!))
    .map((s) => s.id);

  res.json({
    shops: eligible.map((s) => ({
      id: s.id,
      name: s.name,
      city: s.city.name,
      ratingAvg: s.ratingAvg,
      ratingCount: s.ratingCount,
      planName: s.subscription?.plan.name ?? null,
      monthlyPrice: s.subscription?.plan.monthlyPrice ?? null,
    })),
    current,
    // Suggested pick: top 3 eligible by rating (admin can adjust before confirm).
    suggested: eligible.slice(0, 3).map((s) => s.id),
  });
});

const botwSchema = z.object({ shopIds: z.array(z.string()).max(3) });

adminRouter.post("/barber-of-week", validate(botwSchema), async (req, res) => {
  const { shopIds } = parsed<z.infer<typeof botwSchema>>(req);
  if (new Set(shopIds).size !== shopIds.length) {
    throw ApiError.badRequest("Duplicate shop in selection", "BOTW_DUPLICATE");
  }
  const now = new Date();

  if (shopIds.length > 0) {
    const okCount = await prisma.barbershop.count({
      where: { id: { in: shopIds }, ...botwEligibleWhere(now) },
    });
    if (okCount !== shopIds.length) {
      throw ApiError.badRequest(
        "Every selection must be a live, featured-tier shop.",
        "BOTW_INELIGIBLE",
      );
    }
  }

  // Refuse to start a second rollout while one is still going out: it would
  // double every user's feed entry and stack two push waves.
  if (shopIds.length > 0 && isBroadcastRunning()) {
    throw ApiError.conflict(
      "The previous Barber of the Week announcement is still being delivered. Try again shortly.",
      "BROADCAST_IN_PROGRESS",
    );
  }

  // The rank flip is small and immediate — only the picks themselves.
  // Announcing them used to happen in this same transaction, which held it open
  // across the entire user table.
  await prisma.$transaction([
    // Clear the previous week's picks.
    prisma.barbershop.updateMany({
      where: { botwRank: { not: null } },
      data: { botwRank: null, botwSelectedAt: null },
    }),
    // Set the new ranked picks.
    ...shopIds.map((id, i) =>
      prisma.barbershop.update({ where: { id }, data: { botwRank: i + 1, botwSelectedAt: now } }),
    ),
  ]);

  audit(req, {
    action: "barberOfWeek.set",
    targetType: "Barbershop",
    detail: { shopIds },
  });

  // Announce it. Feed rows are written in batches before this resolves; the
  // push wave is metered out over the following minutes so every recipient
  // doesn't open the app in the same second. See services/broadcast.ts.
  let notified = 0;
  if (shopIds.length > 0) {
    const result = await broadcastToAllUsers({
      type: "BARBER_OF_WEEK",
      title: "Barber of the Week",
      body: "This week's top barbershops are in — see them at the top of the app.",
      data: { type: "BARBER_OF_WEEK" },
    });
    notified = result.users;
  }

  res.json({ ok: true, count: shopIds.length, notified });
});

// ---- Subscriptions ----

const subSchema = z.object({
  planId: z.string(),
  months: z.number().int().min(1).max(24).default(1),
});

// PUT = assign or renew a shop's subscription.
adminRouter.put("/shops/:id/subscription", validate(subSchema), async (req, res) => {
  const { planId, months } = parsed<z.infer<typeof subSchema>>(req);
  const [shop, plan] = await Promise.all([
    prisma.barbershop.findUnique({ where: { id: req.params.id }, include: { subscription: true } }),
    prisma.plan.findUnique({ where: { id: planId } }),
  ]);
  if (!shop) throw ApiError.notFound("Barbershop not found");
  if (!plan || !plan.isActive) throw ApiError.badRequest("Unknown or inactive plan", "UNKNOWN_PLAN");

  const now = new Date();
  // Renewals extend from the current period end when it is still in the future.
  const base =
    shop.subscription &&
    shop.subscription.status === "ACTIVE" &&
    shop.subscription.planId === planId &&
    shop.subscription.currentPeriodEnd > now
      ? shop.subscription.currentPeriodEnd
      : now;
  const end = addMonths(base, months);

  const subscription = await prisma.subscription.upsert({
    where: { shopId: shop.id },
    create: {
      shopId: shop.id,
      planId,
      status: "ACTIVE",
      currentPeriodStart: now,
      currentPeriodEnd: end,
    },
    update: { planId, status: "ACTIVE", currentPeriodStart: base, currentPeriodEnd: end },
    include: { plan: { select: { name: true } } },
  });
  // Subscriptions are the revenue event on this platform — this is the single
  // most important thing in the trail.
  audit(req, {
    action: "subscription.assign",
    targetType: "Barbershop",
    targetId: shop.id,
    detail: {
      planId,
      planName: subscription.plan.name,
      months,
      currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    },
  });
  res.json({
    subscription: {
      planName: subscription.plan.name,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
    },
  });
});

adminRouter.delete("/shops/:id/subscription", async (req, res) => {
  const sub = await prisma.subscription
    .update({ where: { shopId: req.params.id }, data: { status: "CANCELLED" } })
    .catch(() => null);
  if (!sub) throw ApiError.notFound("No subscription for this shop");
  audit(req, {
    action: "subscription.cancel",
    targetType: "Barbershop",
    targetId: req.params.id,
    detail: { planId: sub.planId },
  });
  res.json({ ok: true });
});

// ---- Audit trail ----

const auditListSchema = z.object({
  action: z.string().trim().max(60).optional(),
  targetId: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

// Read-only view of the admin trail. There is deliberately no write or delete
// route: the log is append-only, written by lib/audit.ts as a side effect of
// the action it records, and trimmed only by the retention sweep.
adminRouter.get("/audit-logs", validate(auditListSchema, "query"), async (req, res) => {
  const q = parsed<z.infer<typeof auditListSchema>>(req);
  const where = {
    ...(q.action ? { action: q.action } : {}),
    ...(q.targetId ? { targetId: q.targetId } : {}),
  };
  const [total, entries] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);
  res.json({
    entries: entries.map((e) => ({
      id: e.id,
      actorEmail: e.actorEmail,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      detail: e.detail,
      ip: e.ip,
      createdAt: e.createdAt.toISOString(),
    })),
    page: q.page,
    pageSize: q.pageSize,
    total,
  });
});

// ---- Reservations overview ----

const resListSchema = z.object({
  shopId: z.string().optional(),
  // COMPLETED is not a stored status — it is a CONFIRMED booking whose end time
  // has passed — so it is filtered specially below rather than matched directly.
  status: z.enum(["PENDING", "CONFIRMED", "COMPLETED", "DECLINED", "CANCELLED"]).optional(),
  // Inclusive date bounds on the appointment start (ISO date or datetime).
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
});

// Translate the requested status into a Prisma filter on startsAt/status.
// COMPLETED and CONFIRMED both map onto stored status CONFIRMED, split by
// whether the booking has already ended.
function reservationStatusWhere(status: string | undefined, now: Date) {
  switch (status) {
    case undefined:
      return {};
    case "COMPLETED":
      return { status: "CONFIRMED", endsAt: { lt: now } };
    case "CONFIRMED":
      return { status: "CONFIRMED", endsAt: { gte: now } };
    default:
      return { status };
  }
}

adminRouter.get("/reservations", validate(resListSchema, "query"), async (req, res) => {
  const q = parsed<z.infer<typeof resListSchema>>(req);
  const pageSize = 30;
  const now = new Date();
  const where = {
    ...(q.shopId ? { shopId: q.shopId } : {}),
    ...reservationStatusWhere(q.status, now),
    ...(q.from || q.to
      ? { startsAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
      : {}),
  };
  const [total, reservations] = await Promise.all([
    prisma.reservation.count({ where }),
    prisma.reservation.findMany({
      where,
      include: {
        user: { select: { name: true, email: true } },
        shop: { select: { name: true } },
        service: { select: { name: true, price: true } },
        barber: { select: { name: true } },
      },
      orderBy: { startsAt: "desc" },
      skip: (q.page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  res.json({
    reservations: reservations.map((r) => ({
      id: r.id,
      status: r.status === "CONFIRMED" && r.endsAt < now ? "COMPLETED" : r.status,
      startsAt: r.startsAt.toISOString(),
      customer: r.user.name ?? r.user.email,
      shopName: r.shop.name,
      serviceName: r.service.name,
      barberName: r.barber?.name ?? null,
      price: r.price || r.service.price,
    })),
    page: q.page,
    pageSize,
    total,
  });
});

// Admin cancellation of any reservation. Bypasses the customer 2h cutoff — the
// panel exists to handle exactly the short-notice cases self-service blocks —
// and notifies the customer in their own language.
adminRouter.post("/reservations/:id/cancel", async (req, res) => {
  const reservation = await adminCancelReservation(req.params.id);

  audit(req, {
    action: "reservation.cancel",
    targetType: "Reservation",
    targetId: reservation.id,
    detail: { shopId: reservation.shopId, startsAt: reservation.startsAt.toISOString() },
  });

  // Best-effort, in the customer's language. Content names are localized here
  // (notifyUser hands the build fn the recipient's lang) so the push reads the
  // same as the app.
  void notifyUser({
    userId: reservation.userId,
    type: "BOOKING_CANCELLED",
    reservationId: reservation.id,
    build: (lang) =>
      bookingCancelledByShop(lang, {
        service: localize(lang, reservation.service.name, reservation.service.nameAr, reservation.service.nameCkb),
        shop: localize(lang, reservation.shop.name, reservation.shop.nameAr, reservation.shop.nameCkb),
      }),
  });

  res.json({ ok: true });
});

// ---- Reviews (moderation) ----

// A shop's reviews, newest first, for moderation. A review targets a shop (not
// a barber — see the Review model) and feeds the denormalized ratingAvg that
// drives list ordering and Barber-of-the-Week eligibility, so an abusive or
// mistaken one is worth being able to remove.
adminRouter.get("/shops/:id/reviews", async (req, res) => {
  const shop = await prisma.barbershop.findUnique({
    where: { id: req.params.id },
    select: { id: true, name: true, ratingAvg: true, ratingCount: true },
  });
  if (!shop) throw ApiError.notFound("Barbershop not found");
  const reviews = await prisma.review.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    include: { user: { select: { name: true, email: true } } },
  });
  res.json({
    shop,
    reviews: reviews.map((r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      customer: r.user.name ?? r.user.email,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

adminRouter.delete("/reviews/:id", async (req, res) => {
  const review = await prisma.review.findUnique({ where: { id: req.params.id } });
  if (!review) throw ApiError.notFound("Review not found");

  // Delete and refresh the shop's denormalized aggregate in one transaction, the
  // same way a review write maintains it (see routes/reviews.ts) — otherwise
  // ratingAvg/ratingCount would drift from the surviving rows.
  await prisma.$transaction(async (tx) => {
    await tx.review.delete({ where: { id: review.id } });
    const agg = await tx.review.aggregate({
      where: { shopId: review.shopId },
      _avg: { rating: true },
      _count: true,
    });
    await tx.barbershop.update({
      where: { id: review.shopId },
      data: {
        ratingAvg: Math.round((agg._avg.rating ?? 0) * 10) / 10,
        ratingCount: agg._count,
      },
    });
  });

  audit(req, {
    action: "review.delete",
    targetType: "Review",
    targetId: review.id,
    detail: { shopId: review.shopId, rating: review.rating },
  });
  res.json({ ok: true });
});

// ---- Admin users ----

// Managing who can sign in to the panel. The audit trail records actorId +
// actorEmail on every write, so "who did this" is only meaningful once there is
// more than one admin — until then every row carries the same shared login.
// Disable rather than delete: the trail references these rows.
const adminCreateSchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().min(2).max(80),
  password: z.string().min(8).max(200),
});
const adminUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    password: z.string().min(8).max(200).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

adminRouter.get("/admins", async (_req, res) => {
  const admins = await prisma.adminUser.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, name: true, isActive: true, createdAt: true },
  });
  res.json({ admins: admins.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })) });
});

adminRouter.post("/admins", validate(adminCreateSchema), async (req, res) => {
  const body = parsed<z.infer<typeof adminCreateSchema>>(req);
  const email = body.email.toLowerCase();
  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing) throw ApiError.conflict("An admin with that email already exists", "ADMIN_EXISTS");

  const admin = await prisma.adminUser.create({
    data: { email, name: body.name, passwordHash: await bcrypt.hash(body.password, 10) },
    select: { id: true, email: true, name: true, isActive: true, createdAt: true },
  });
  audit(req, {
    action: "admin.create",
    targetType: "AdminUser",
    targetId: admin.id,
    // Never the password or its hash.
    detail: { email: admin.email, name: admin.name },
  });
  res.status(201).json({ admin: { ...admin, createdAt: admin.createdAt.toISOString() } });
});

adminRouter.patch("/admins/:id", validate(adminUpdateSchema), async (req, res) => {
  const body = parsed<z.infer<typeof adminUpdateSchema>>(req);
  const target = await prisma.adminUser.findUnique({ where: { id: req.params.id } });
  if (!target) throw ApiError.notFound("Admin not found");

  // Two lockout guards, both on disabling:
  //   1. You can't disable yourself — that would end your own session's ability
  //      to re-enable anyone.
  //   2. You can't disable the last active admin — the panel would become
  //      unreachable with no way back in short of the database.
  if (body.isActive === false) {
    if (target.id === req.auth!.userId) {
      throw ApiError.badRequest("You can't disable your own account", "ADMIN_SELF_DISABLE");
    }
    if (target.isActive) {
      const activeCount = await prisma.adminUser.count({ where: { isActive: true } });
      if (activeCount <= 1) {
        throw ApiError.badRequest("At least one admin must stay active", "ADMIN_LAST_ACTIVE");
      }
    }
  }

  const admin = await prisma.adminUser.update({
    where: { id: target.id },
    data: {
      name: body.name,
      isActive: body.isActive,
      ...(body.password ? { passwordHash: await bcrypt.hash(body.password, 10) } : {}),
    },
    select: { id: true, email: true, name: true, isActive: true, createdAt: true },
  });
  audit(req, {
    action: "admin.update",
    targetType: "AdminUser",
    targetId: admin.id,
    // Field names only — never the new password.
    detail: { fields: Object.keys(body) },
  });
  res.json({ admin: { ...admin, createdAt: admin.createdAt.toISOString() } });
});

// ---- Announcements ----

// A general platform-wide announcement, delivered over the same paced broadcast
// engine as Barber of the Week (services/broadcast.ts): feed rows written in
// batches, pushes metered out over minutes. Guarded against overlapping runs so
// two announcements can't double every user's feed or stack two push waves.
const announcementSchema = z.object({
  title: z.string().trim().min(3).max(80),
  body: z.string().trim().min(3).max(300),
});

adminRouter.post("/announcements", validate(announcementSchema), async (req, res) => {
  const { title, body } = parsed<z.infer<typeof announcementSchema>>(req);

  if (isBroadcastRunning()) {
    throw ApiError.conflict(
      "Another announcement is still being delivered. Try again shortly.",
      "BROADCAST_IN_PROGRESS",
    );
  }

  const result = await broadcastToAllUsers({
    type: "ANNOUNCEMENT",
    title,
    body,
    data: { type: "ANNOUNCEMENT" },
  });

  audit(req, {
    action: "announcement.send",
    targetType: "Announcement",
    detail: { title, users: result.users },
  });

  res.json({ ok: true, users: result.users });
});

// ---- Customers ----

const customerListSchema = z.object({
  // Filters by name or email (case-insensitive substring).
  search: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

// Every customer, newest first, with the reviews they've written. A review
// targets a barbershop (not an individual barber) — see the Review model — so
// each entry names the shop. Read-only; not audited. Barbers are customers too
// (a barber is a User whose email also exists in the Barber table), so they
// appear here as well.
adminRouter.get("/customers", validate(customerListSchema, "query"), async (req, res) => {
  const q = parsed<z.infer<typeof customerListSchema>>(req);
  const pageSize = 25;
  const where = q.search
    ? {
        OR: [
          { name: { contains: q.search, mode: "insensitive" as const } },
          { email: { contains: q.search, mode: "insensitive" as const } },
        ],
      }
    : {};
  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * pageSize,
      take: pageSize,
      include: {
        _count: { select: { reservations: true, reviews: true } },
        reviews: {
          include: { shop: { select: { name: true } } },
          orderBy: { createdAt: "desc" },
        },
      },
    }),
  ]);
  res.json({
    customers: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      createdAt: u.createdAt.toISOString(),
      reservationCount: u._count.reservations,
      reviewCount: u._count.reviews,
      reviews: u.reviews.map((r) => ({
        id: r.id,
        shopName: r.shop.name,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
      })),
    })),
    page: q.page,
    pageSize,
    total,
  });
});
