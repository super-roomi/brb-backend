-- Every barbershop now carries a standard "Haircut & Beard Trim" combo. New
-- shops get it on creation; this migration adds the flag and backfills one into
-- every existing shop that doesn't already have a standard service, so the
-- app's quick-booking flow always has a service to preselect.
ALTER TABLE "Service" ADD COLUMN "isStandard" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: insert the standard combo (with Ar/Ckb translations) into each shop
-- lacking one. gen_random_uuid() is core in PostgreSQL 13+; the id column is
-- plain text so a uuid value is fine alongside the app's cuids.
INSERT INTO "Service" ("id", "shopId", "name", "nameAr", "nameCkb", "durationMin", "price", "isActive", "isStandard")
SELECT
  gen_random_uuid()::text,
  s."id",
  'Haircut & Beard Trim',
  'قص شعر وتهذيب لحية',
  'قژبڕین و ڕێکخستنی ڕیش',
  45,
  20000,
  true,
  true
FROM "Barbershop" s
WHERE NOT EXISTS (
  SELECT 1 FROM "Service" sv WHERE sv."shopId" = s."id" AND sv."isStandard" = true
);
