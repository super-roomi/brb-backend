import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
import { validate, parsed } from "../middleware/validate.js";
import { computeFreeSlots } from "../services/availability.js";
import { isShopLive, liveShopWhere } from "../services/booking.js";
import { isValidDateString } from "../lib/time.js";
import { parseLang, localize } from "../lib/localize.js";

export const catalogRouter = Router();

catalogRouter.get("/cities", async (_req, res) => {
  const cities = await prisma.city.findMany({ orderBy: { name: "asc" } });
  // Cities change rarely; let clients/CDN hold this briefly.
  res.set("Cache-Control", "public, max-age=60");
  res.json({ cities: cities.map((c) => ({ id: c.id, name: c.name, slug: c.slug })) });
});

const listSchema = z.object({
  cityId: z.string().optional(),
  search: z.string().trim().max(80).optional(),
  sort: z.enum(["rating", "name"]).default("rating"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

catalogRouter.get("/shops", validate(listSchema, "query"), async (req, res) => {
  const q = parsed<z.infer<typeof listSchema>>(req);
  const lang = parseLang(req.query.lang);
  const where = {
    ...liveShopWhere(),
    ...(q.cityId ? { cityId: q.cityId } : {}),
    // Postgres `contains` is case-sensitive (SQLite's LIKE was not); make search
    // case-insensitive so "barber" matches "Barber".
    ...(q.search ? { name: { contains: q.search, mode: "insensitive" as const } } : {}),
  };
  // Featured-tier shops sort first across the WHOLE list, then by the requested
  // order. Doing this in the query (not by re-sorting a page in JS) keeps
  // featured shops on top even past page 1 — the paid tier's whole point.
  const featuredFirst = { subscription: { plan: { isFeaturedTier: "desc" as const } } };
  const [total, shops] = await Promise.all([
    prisma.barbershop.count({ where }),
    prisma.barbershop.findMany({
      where,
      include: {
        city: { select: { id: true, name: true } },
        subscription: { select: { plan: { select: { isFeaturedTier: true } } } },
      },
      orderBy:
        q.sort === "rating"
          ? [featuredFirst, { ratingAvg: "desc" }, { ratingCount: "desc" }]
          : [featuredFirst, { name: "asc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);

  const items = shops.map((s) => ({
    id: s.id,
    name: localize(lang, s.name, s.nameAr, s.nameCkb),
    description: localize(lang, s.description, s.descriptionAr, s.descriptionCkb),
    address: s.address,
    imageUrl: s.imageUrl,
    city: s.city,
    // Coordinates power the app's "Quick booking" nearest-shop pick. Already
    // public on the shop detail endpoint, so no new exposure.
    latitude: s.latitude,
    longitude: s.longitude,
    ratingAvg: s.ratingAvg,
    ratingCount: s.ratingCount,
    isFeatured: s.subscription?.plan.isFeaturedTier ?? false,
  }));

  // Browse traffic dwarfs writes; a short public cache absorbs repeat opens.
  res.set("Cache-Control", "public, max-age=60");
  res.json({ shops: items, page: q.page, pageSize: q.pageSize, total });
});

// Barber of the Week: up to 3 curated shops shown atop the app home, below the
// search. Registered before "/shops/:id" so it isn't matched as an id.
catalogRouter.get("/shops/of-the-week", async (req, res) => {
  const lang = parseLang(req.query.lang);
  // Auto-expire a stale selection after a week (in case the admin didn't reset).
  const cutoff = new Date(Date.now() - 7 * 86_400_000);
  const shops = await prisma.barbershop.findMany({
    where: { botwRank: { not: null }, botwSelectedAt: { gte: cutoff }, ...liveShopWhere() },
    include: { city: { select: { id: true, name: true } } },
    orderBy: { botwRank: "asc" },
    take: 3,
  });
  res.json({
    shops: shops.map((s) => ({
      id: s.id,
      name: localize(lang, s.name, s.nameAr, s.nameCkb),
      description: localize(lang, s.description, s.descriptionAr, s.descriptionCkb),
      address: s.address,
      imageUrl: s.imageUrl,
      city: s.city,
      ratingAvg: s.ratingAvg,
      ratingCount: s.ratingCount,
      isFeatured: true,
    })),
  });
});

catalogRouter.get("/shops/:id", async (req, res) => {
  const shop = await prisma.barbershop.findUnique({
    where: { id: req.params.id },
    include: {
      city: { select: { id: true, name: true } },
      services: { where: { isActive: true }, orderBy: { price: "asc" } },
      openingHours: { orderBy: { weekday: "asc" } },
      barbers: { where: { isActive: true }, orderBy: { name: "asc" } },
      subscription: { include: { plan: true } },
    },
  });
  if (!shop || !isShopLive(shop)) throw ApiError.notFound("Barbershop not found");

  const lang = parseLang(req.query.lang);
  res.json({
    shop: {
      id: shop.id,
      name: localize(lang, shop.name, shop.nameAr, shop.nameCkb),
      description: localize(lang, shop.description, shop.descriptionAr, shop.descriptionCkb),
      address: shop.address,
      phone: shop.phone,
      imageUrl: shop.imageUrl,
      city: shop.city,
      chairCount: shop.chairCount,
      utcOffsetMinutes: shop.utcOffsetMinutes,
      latitude: shop.latitude,
      longitude: shop.longitude,
      locationLabel:
        localize(lang, shop.locationLabel ?? "", shop.locationLabelAr, shop.locationLabelCkb) || null,
      ratingAvg: shop.ratingAvg,
      ratingCount: shop.ratingCount,
      isFeatured: shop.subscription?.plan.isFeaturedTier ?? false,
      social: {
        instagram: shop.instagramUrl,
        facebook: shop.facebookUrl,
        tiktok: shop.tiktokUrl,
        snapchat: shop.snapchatUrl,
      },
      services: shop.services.map((s) => ({
        id: s.id,
        name: localize(lang, s.name, s.nameAr, s.nameCkb),
        durationMin: s.durationMin,
        price: s.price,
      })),
      barbers: shop.barbers.map((b) => ({
        id: b.id,
        name: localize(lang, b.name, b.nameAr, b.nameCkb),
      })),
      openingHours: shop.openingHours.map((h) => ({
        weekday: h.weekday,
        openMinute: h.openMinute,
        closeMinute: h.closeMinute,
      })),
    },
  });
});

const reviewsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

catalogRouter.get(
  "/shops/:id/reviews",
  validate(reviewsSchema, "query"),
  async (req, res) => {
    const q = parsed<z.infer<typeof reviewsSchema>>(req);
    // Don't expose reviews for shops that aren't live (hidden/expired/never
    // published) — same visibility rule as shop detail.
    const shop = await prisma.barbershop.findUnique({
      where: { id: req.params.id },
      include: { subscription: true },
    });
    if (!shop || !isShopLive(shop)) throw ApiError.notFound("Barbershop not found");

    const where = { shopId: req.params.id };
    const [total, reviews] = await Promise.all([
      prisma.review.count({ where }),
      prisma.review.findMany({
        where,
        include: { user: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    res.json({
      reviews: reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        authorName: r.user.name ?? "Customer",
        createdAt: r.createdAt.toISOString(),
      })),
      page: q.page,
      pageSize: q.pageSize,
      total,
    });
  },
);

const availabilitySchema = z.object({
  date: z.string().refine(isValidDateString, "Expected YYYY-MM-DD"),
  serviceId: z.string(),
  // Optional: restrict availability to one barber.
  barberId: z.string().optional(),
});

catalogRouter.get(
  "/shops/:id/availability",
  validate(availabilitySchema, "query"),
  async (req, res) => {
    const q = parsed<z.infer<typeof availabilitySchema>>(req);
    const slots = await computeFreeSlots(req.params.id, q.date, q.serviceId, q.barberId);
    res.json({ date: q.date, slots });
  },
);
