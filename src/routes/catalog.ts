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
        subscription: {
          select: {
            plan: { select: { isFeaturedTier: true, monthlyPrice: true } },
          },
        },
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
    // Subscription-tier weight for the app's quick-booking recommendation
    // (higher = better placement). The plan's monthly price doubles as the
    // ordering value; visible shops always have an active subscription.
    tierRank: s.subscription?.plan.monthlyPrice ?? 0,
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
  // This is the endpoint a Barber-of-the-Week broadcast drives every recipient
  // straight at, so it is the one that most needs to absorb a spike. The
  // selection changes weekly, so a short shared cache costs nothing.
  res.set("Cache-Control", "public, max-age=300");
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

// Nearest live shops to a coordinate. Registered before "/shops/:id" so
// "nearby" isn't matched as an id.
//
// The app used to fetch the first page of shops and measure distance on-device.
// That silently stops being correct the moment more than `pageSize` shops are
// live — the "nearest 3" would only ever be the nearest 3 *of the highest-tier
// page*, not of the city — and it shipped the whole list on every quick-book
// open. Distance now belongs to the database.
const nearbySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().min(0.1).max(100).default(3),
  limit: z.coerce.number().int().min(1).max(20).default(3),
});

// Latitude is ~111.32 km per degree everywhere; longitude shrinks by cos(lat).
const KM_PER_DEG_LAT = 111.32;
const EARTH_RADIUS_KM = 6371;

catalogRouter.get("/shops/nearby", validate(nearbySchema, "query"), async (req, res) => {
  const q = parsed<z.infer<typeof nearbySchema>>(req);
  const lang = parseLang(req.query.lang);

  // Bounding box first: it is a plain indexed range scan (see the geo index in
  // the 20260726 migration), and it discards almost everything before the
  // trigonometry runs. The box is a superset of the circle, so the exact
  // haversine filter below still decides membership.
  const latDelta = q.radiusKm / KM_PER_DEG_LAT;
  const cosLat = Math.cos((q.lat * Math.PI) / 180);
  // Guard the poles, where cos(lat) collapses and the longitude span explodes.
  const lngDelta =
    Math.abs(cosLat) < 0.01 ? 180 : q.radiusKm / (KM_PER_DEG_LAT * Math.abs(cosLat));

  const candidates = await prisma.barbershop.findMany({
    where: {
      ...liveShopWhere(),
      latitude: { not: null, gte: q.lat - latDelta, lte: q.lat + latDelta },
      longitude: { not: null, gte: q.lng - lngDelta, lte: q.lng + lngDelta },
    },
    include: {
      city: { select: { id: true, name: true } },
      subscription: { select: { plan: { select: { isFeaturedTier: true, monthlyPrice: true } } } },
    },
    // Hard cap: a huge radius must not turn into an unbounded scan. Well above
    // any plausible number of shops inside a city-sized radius.
    take: 200,
  });

  const withDistance = candidates
    .map((s) => ({ shop: s, meters: haversineMeters(q.lat, q.lng, s.latitude!, s.longitude!) }))
    .filter((c) => c.meters <= q.radiusKm * 1000)
    .sort((a, b) => a.meters - b.meters)
    .slice(0, q.limit);

  res.json({
    shops: withDistance.map(({ shop: s, meters }) => ({
      id: s.id,
      name: localize(lang, s.name, s.nameAr, s.nameCkb),
      description: localize(lang, s.description, s.descriptionAr, s.descriptionCkb),
      address: s.address,
      imageUrl: s.imageUrl,
      city: s.city,
      latitude: s.latitude,
      longitude: s.longitude,
      ratingAvg: s.ratingAvg,
      ratingCount: s.ratingCount,
      isFeatured: s.subscription?.plan.isFeaturedTier ?? false,
      tierRank: s.subscription?.plan.monthlyPrice ?? 0,
      // Server-measured, so the client no longer needs every shop's coordinates
      // to rank them.
      distanceMeters: Math.round(meters),
    })),
  });
});

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * 1000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

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
      // 0 when this shop isn't running "bring a friend"; the app hides the
      // whole feature in that case rather than offering an unearnable discount.
      referralDiscount: shop.referralDiscount,
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
        // Flags the standard "Haircut & Beard Trim" combo the app's quick
        // booking preselects.
        isStandard: s.isStandard,
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
