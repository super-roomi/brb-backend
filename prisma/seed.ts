// Demo data: one city (Sulaymaniyah), plans, an admin, three barbershops with
// services / hours / named barbers, a demo customer with a completed visit +
// review, and one barber login for testing the barber dashboard.
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@barberapp.dev";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "admin1234";

  await prisma.adminUser.upsert({
    where: { email: adminEmail },
    create: {
      email: adminEmail,
      name: "Platform Admin",
      passwordHash: await bcrypt.hash(adminPassword, 10),
    },
    update: {},
  });

  // Single city per requirements.
  const city = await prisma.city.upsert({
    where: { slug: "sulaymaniyah" },
    create: { name: "Sulaymaniyah", slug: "sulaymaniyah" },
    update: {},
  });

  const plans = await Promise.all(
    [
      { name: "Basic", monthlyPrice: 25_000, features: "Listed in the app\nUp to 10 services", isFeaturedTier: false },
      { name: "Pro", monthlyPrice: 50_000, features: "Everything in Basic\nPriority support", isFeaturedTier: false },
      { name: "Premium", monthlyPrice: 100_000, features: "Everything in Pro\nFeatured placement in search", isFeaturedTier: true },
    ].map((p) =>
      prisma.plan.upsert({ where: { name: p.name }, create: p, update: p }),
    ),
  );

  const fullWeek = [0, 1, 2, 3, 4, 6].map((weekday) => ({
    weekday,
    openMinute: 10 * 60, // 10:00
    closeMinute: 21 * 60, // 21:00
  })); // closed Friday (weekday 5)

  const shopSpecs = [
    {
      name: "The Heritage Grooming Co.",
      description:
        "Premium fades and hot towel shaves in a minimalist setting. A sanctuary for the modern gentleman.",
      address: "124 Heritage Ave, Downtown",
      phone: "+9647501000001",
      imageUrl:
        "https://images.unsplash.com/photo-1585747860715-2ba37e788b70?w=1200&q=80",
      plan: plans[2],
      chairCount: 3,
      latitude: 35.561,
      longitude: 45.433,
      instagramUrl: "https://instagram.com/heritagegrooming",
      tiktokUrl: "https://tiktok.com/@heritagegrooming",
      services: [
        { name: "Classic Haircut", durationMin: 30, price: 15_000 },
        { name: "Beard Trim & Shape", durationMin: 20, price: 8_000 },
        { name: "Hot Towel Shave", durationMin: 30, price: 12_000 },
        { name: "Haircut + Beard Combo", durationMin: 45, price: 20_000 },
      ],
      barbers: [
        { name: "Aland Kareem", email: "aland.kareem@barberapp.dev" },
        { name: "Rebin Salih", email: "rebin.salih@barberapp.dev" },
        { name: "Hemin Aziz", email: "hemin.aziz@barberapp.dev" },
      ],
    },
    {
      name: "Precision Cuts",
      description:
        "Specializing in sharp line-ups and modern styling techniques for every generation.",
      address: "45 Salim Street, Westside",
      phone: "+9647501000002",
      imageUrl:
        "https://images.unsplash.com/photo-1503951914875-452162b0f3f1?w=1200&q=80",
      plan: plans[1],
      chairCount: 2,
      latitude: 35.5675,
      longitude: 45.403,
      instagramUrl: "https://instagram.com/precisioncuts",
      snapchatUrl: "https://snapchat.com/add/precisioncuts",
      services: [
        { name: "Skin Fade", durationMin: 40, price: 18_000 },
        { name: "Kids Cut", durationMin: 25, price: 10_000 },
        { name: "Line-up", durationMin: 15, price: 6_000 },
      ],
      barbers: [
        { name: "Karwan Jamal", email: "karwan.jamal@barberapp.dev" },
        { name: "Diyar Omar", email: "diyar.omar@barberapp.dev" },
      ],
    },
    {
      name: "Apex Barbers",
      description:
        "Award-winning team offering complete grooming packages and consultations.",
      address: "8 Nawroz Blvd, City Center",
      phone: "+9647501000003",
      imageUrl:
        "https://images.unsplash.com/photo-1521490878406-4d2e17f8bde1?w=1200&q=80",
      plan: plans[0],
      chairCount: 2,
      latitude: 35.5556,
      longitude: 45.4356,
      facebookUrl: "https://facebook.com/apexbarbers",
      services: [
        { name: "Signature Cut", durationMin: 35, price: 16_000 },
        { name: "Grooming Package", durationMin: 60, price: 30_000 },
      ],
      barbers: [
        { name: "Shwan Ali", email: "shwan.ali@barberapp.dev" },
        { name: "Bahroz Nuri", email: "bahroz.nuri@barberapp.dev" },
      ],
    },
  ];

  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 6);

  for (const spec of shopSpecs) {
    const existing = await prisma.barbershop.findFirst({ where: { name: spec.name } });
    if (existing) continue;
    await prisma.barbershop.create({
      data: {
        name: spec.name,
        description: spec.description,
        address: spec.address,
        phone: spec.phone,
        imageUrl: spec.imageUrl,
        cityId: city.id,
        chairCount: spec.chairCount,
        isVisible: true,
        latitude: spec.latitude ?? null,
        longitude: spec.longitude ?? null,
        instagramUrl: spec.instagramUrl ?? null,
        facebookUrl: spec.facebookUrl ?? null,
        tiktokUrl: spec.tiktokUrl ?? null,
        snapchatUrl: spec.snapchatUrl ?? null,
        services: { create: spec.services },
        openingHours: { create: fullWeek },
        barbers: { create: spec.barbers },
        subscription: {
          create: {
            planId: spec.plan.id,
            status: "ACTIVE",
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
          },
        },
      },
    });
  }

  // Developer test user — what POST /api/auth/test-login signs in as.
  await prisma.user.upsert({
    where: { email: "tester@barberapp.dev" },
    create: { email: "tester@barberapp.dev", name: "Test User" },
    update: {},
  });

  // Demo customer with a completed visit at each shop + a review.
  const demoUser = await prisma.user.upsert({
    where: { email: "demo@barberapp.dev" },
    create: { email: "demo@barberapp.dev", name: "Demo Customer" },
    update: {},
  });

  const shops = await prisma.barbershop.findMany({
    include: { services: true, barbers: true },
  });
  const comments: Record<string, { rating: number; comment: string }> = {
    "The Heritage Grooming Co.": { rating: 5, comment: "Immaculate fade and a genuinely relaxing hot towel shave. Worth every dinar." },
    "Precision Cuts": { rating: 5, comment: "Sharpest line-up in the city. Booked again before I left the chair." },
    "Apex Barbers": { rating: 4, comment: "Great grooming package, friendly team. Gets busy on weekends." },
  };

  for (const shop of shops) {
    const done = await prisma.reservation.findFirst({
      where: { userId: demoUser.id, shopId: shop.id },
    });
    if (done || shop.services.length === 0) continue;
    const service = shop.services[0];
    const barber = shop.barbers[0] ?? null;
    // A few completed visits over the past two weeks so barber stats are non-zero.
    for (let i = 1; i <= 3; i++) {
      const start = new Date(now.getTime() - i * 3 * 86_400_000);
      await prisma.reservation.create({
        data: {
          userId: demoUser.id,
          shopId: shop.id,
          serviceId: service.id,
          barberId: barber?.id ?? null,
          price: service.price,
          startsAt: start,
          endsAt: new Date(start.getTime() + service.durationMin * 60_000),
          status: "CONFIRMED",
        },
      });
    }
    // One future PENDING request so each barber's dashboard has something to
    // accept/decline out of the box.
    if (barber) {
      const pendingStart = new Date(now.getTime() + 2 * 86_400_000);
      await prisma.reservation.create({
        data: {
          userId: demoUser.id,
          shopId: shop.id,
          serviceId: service.id,
          barberId: barber.id,
          price: service.price,
          startsAt: pendingStart,
          endsAt: new Date(pendingStart.getTime() + service.durationMin * 60_000),
          status: "PENDING",
        },
      });
    }
    const c = comments[shop.name];
    if (c) {
      await prisma.review.create({
        data: { userId: demoUser.id, shopId: shop.id, rating: c.rating, comment: c.comment },
      });
      const agg = await prisma.review.aggregate({
        where: { shopId: shop.id },
        _avg: { rating: true },
        _count: true,
      });
      await prisma.barbershop.update({
        where: { id: shop.id },
        data: {
          ratingAvg: Math.round((agg._avg.rating ?? 0) * 10) / 10,
          ratingCount: agg._count,
        },
      });
    }
  }

  console.log("Seed complete.");
  console.log(`Admin login: ${adminEmail} / ${adminPassword}`);
  console.log("Dev login: POST /api/auth/test-login (tester@barberapp.dev), or the app's test-login button");
  console.log("Demo customer: demo@barberapp.dev (test-login with {\"email\":\"demo@barberapp.dev\"})");
  console.log("Demo BARBER: aland.kareem@barberapp.dev (Aland Kareem @ The Heritage Grooming Co.)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
