import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
import { signAccessToken } from "../lib/jwt.js";
import { requireAdmin } from "../middleware/auth.js";
import { validate, parsed } from "../middleware/validate.js";
import { isShopLive } from "../services/booking.js";
import { tryNormalizePhone } from "../lib/phone.js";
import { adminLoginLimiter } from "../middleware/rateLimit.js";
import { addMonths } from "../lib/time.js";
import { env } from "../env.js";

export const adminRouter = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });

adminRouter.post("/login", adminLoginLimiter, validate(loginSchema), async (req, res) => {
  const { email, password } = parsed<z.infer<typeof loginSchema>>(req);
  const admin = await prisma.adminUser.findUnique({ where: { email } });
  // Same error for unknown email and wrong password — no account probing.
  if (!admin || !(await bcrypt.compare(password, admin.passwordHash))) {
    throw ApiError.unauthorized("Invalid credentials", "BAD_CREDENTIALS");
  }
  res.json({
    accessToken: signAccessToken({ sub: admin.id, role: "admin" }, env.adminAccessTtl),
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
  res.status(201).json({ city });
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
  // Normalize to canonical E.164 at the boundary. A barber logs into the mobile
  // app with this number, and the barber-identity lookup is exact string
  // equality against the User's (already-normalized) phone — so an un-normalized
  // stored phone would silently lock the barber out of their dashboard.
  phone: z
    .string()
    .trim()
    .min(8)
    .max(20)
    .transform((v, ctx) => {
      const normalized = tryNormalizePhone(v);
      if (!normalized) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Phone must be in international format, e.g. +9647501234567",
        });
        return z.NEVER;
      }
      return normalized;
    }),
  isActive: z.boolean().default(true),
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
  utcOffsetMinutes: z.number().int().min(-720).max(840).default(180),
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

adminRouter.get("/shops", async (_req, res) => {
  const shops = await prisma.barbershop.findMany({
    include: {
      city: { select: { id: true, name: true } },
      subscription: { include: { plan: { select: { id: true, name: true, isFeaturedTier: true } } } },
      _count: { select: { reservations: true, reviews: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json({
    shops: shops.map((s) => ({
      id: s.id,
      name: s.name,
      city: s.city,
      address: s.address,
      isVisible: s.isVisible,
      isLive: isShopLive(s),
      ratingAvg: s.ratingAvg,
      ratingCount: s.ratingCount,
      reservationCount: s._count.reservations,
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

  await assertBarberPhonesFree(body.barbers ?? []);

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
        utcOffsetMinutes: body.utcOffsetMinutes,
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
          create: body.services.map((s) => ({
            name: s.name,
            nameAr: emptyToNull(s.nameAr) ?? null,
            nameCkb: emptyToNull(s.nameCkb) ?? null,
            durationMin: s.durationMin,
            price: s.price,
            isActive: s.isActive,
          })),
        },
        openingHours: { create: body.openingHours },
        barbers: {
          create: (body.barbers ?? []).map((b) => ({
            name: b.name,
            nameAr: emptyToNull(b.nameAr) ?? null,
            nameCkb: emptyToNull(b.nameCkb) ?? null,
            phone: b.phone,
            isActive: b.isActive,
          })),
        },
      },
    })
    .catch(rethrowBarberPhoneConflict);
  res.status(201).json({ shop: { id: shop.id } });
});

// The pre-check below narrows most conflicts to a friendly 409, but two admins
// saving the same new phone concurrently can still slip past it and hit the DB
// unique constraint. Translate that P2002 into the same 409 instead of a 500.
function rethrowBarberPhoneConflict(e: unknown): never {
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === "P2002" &&
    String(e.meta?.target ?? "").includes("phone")
  ) {
    throw ApiError.conflict("That barber phone is already in use", "BARBER_PHONE_TAKEN");
  }
  throw e;
}

// A barber phone must be unique across the whole platform (it is a login).
async function assertBarberPhonesFree(
  barbers: { id?: string; phone: string }[],
  shopId?: string,
) {
  const phones = barbers.map((b) => b.phone);
  if (new Set(phones).size !== phones.length) {
    throw ApiError.badRequest("Duplicate barber phone in this shop", "DUP_BARBER_PHONE");
  }
  const clashes = await prisma.barber.findMany({
    where: { phone: { in: phones } },
  });
  for (const clash of clashes) {
    const submitted = barbers.find((b) => b.phone === clash.phone);
    // OK when it is the same barber being edited in the same shop.
    if (!(submitted?.id === clash.id && clash.shopId === shopId)) {
      throw ApiError.conflict(
        `Phone ${clash.phone} already belongs to another barber`,
        "BARBER_PHONE_TAKEN",
      );
    }
  }
}

adminRouter.patch("/shops/:id", validate(shopBase.partial()), async (req, res) => {
  const body = parsed<z.infer<ReturnType<typeof shopBase.partial>>>(req);
  const existing = await prisma.barbershop.findUnique({ where: { id: req.params.id } });
  if (!existing) throw ApiError.notFound("Barbershop not found");
  if (body.barbers) await assertBarberPhonesFree(body.barbers, existing.id);

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
        utcOffsetMinutes: body.utcOffsetMinutes,
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
      // are never deleted — deactivate instead.
      const keptIds = body.services.filter((s) => s.id).map((s) => s.id!);
      await tx.service.updateMany({
        where: { shopId: existing.id, id: { notIn: keptIds } },
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
              phone: b.phone,
              isActive: b.isActive,
            },
          });
        } else {
          await tx.barber.create({
            data: {
              shopId: existing.id,
              name: b.name,
              nameAr: emptyToNull(b.nameAr) ?? null,
              nameCkb: emptyToNull(b.nameCkb) ?? null,
              phone: b.phone,
              isActive: b.isActive,
            },
          });
        }
      }
    }
  }).catch(rethrowBarberPhoneConflict);
  res.json({ ok: true });
});

const visibilitySchema = z.object({ isVisible: z.boolean() });

adminRouter.patch("/shops/:id/visibility", validate(visibilitySchema), async (req, res) => {
  const { isVisible } = parsed<z.infer<typeof visibilitySchema>>(req);
  const shop = await prisma.barbershop
    .update({ where: { id: req.params.id }, data: { isVisible } })
    .catch(() => null);
  if (!shop) throw ApiError.notFound("Barbershop not found");
  res.json({ id: shop.id, isVisible: shop.isVisible });
});

// ---- Plans ----

adminRouter.get("/plans", async (_req, res) => {
  const plans = await prisma.plan.findMany({
    orderBy: { monthlyPrice: "asc" },
    include: { _count: { select: { subscriptions: true } } },
  });
  res.json({
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      monthlyPrice: p.monthlyPrice,
      features: p.features,
      isFeaturedTier: p.isFeaturedTier,
      isActive: p.isActive,
      subscriberCount: p._count.subscriptions,
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
  const plan = await prisma.plan.create({ data: parsed<z.infer<typeof planSchema>>(req) });
  res.status(201).json({ plan });
});

adminRouter.patch("/plans/:id", validate(planSchema.partial()), async (req, res) => {
  const plan = await prisma.plan
    .update({ where: { id: req.params.id }, data: parsed<z.infer<ReturnType<typeof planSchema.partial>>>(req) })
    .catch(() => null);
  if (!plan) throw ApiError.notFound("Plan not found");
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

  const users = shopIds.length > 0 ? await prisma.user.findMany({ select: { id: true } }) : [];

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
    // In-app feed notification for every user (real APNs/FCM push would layer
    // onto these same records).
    ...(users.length > 0
      ? [
          prisma.notification.createMany({
            data: users.map((u) => ({
              userId: u.id,
              type: "BARBER_OF_WEEK",
              title: "Barber of the Week",
              body: "This week's top barbershops are in — see them at the top of the app.",
            })),
          }),
        ]
      : []),
  ]);

  res.json({ ok: true, count: shopIds.length, notified: users.length });
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
  res.json({ ok: true });
});

// ---- Reservations overview ----

const resListSchema = z.object({
  shopId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
});

adminRouter.get("/reservations", validate(resListSchema, "query"), async (req, res) => {
  const q = parsed<z.infer<typeof resListSchema>>(req);
  const pageSize = 30;
  const where = q.shopId ? { shopId: q.shopId } : {};
  const [total, reservations] = await Promise.all([
    prisma.reservation.count({ where }),
    prisma.reservation.findMany({
      where,
      include: {
        user: { select: { name: true, phone: true } },
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
      status: r.status === "CONFIRMED" && r.endsAt < new Date() ? "COMPLETED" : r.status,
      startsAt: r.startsAt.toISOString(),
      customer: r.user.name ?? r.user.phone,
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
