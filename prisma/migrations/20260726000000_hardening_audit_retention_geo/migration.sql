-- Hardening pass: admin audit trail, account anonymization, retention indexes,
-- and the indexes behind server-side nearby-shop search.

-- ---------------------------------------------------------------------------
-- 1. Admin audit trail
-- ---------------------------------------------------------------------------
-- Append-only. Admin writes are billing events (subscriptions, plan pricing,
-- visibility, featured placement) and previously left no trace at all.
CREATE TABLE "AuditLog" (
  "id"         TEXT NOT NULL,
  "actorId"    TEXT NOT NULL,
  "actorEmail" TEXT NOT NULL,
  "action"     TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId"   TEXT,
  "detail"     TEXT,
  "ip"         TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");
CREATE INDEX "AuditLog_targetType_targetId_createdAt_idx"
  ON "AuditLog"("targetType", "targetId", "createdAt");

-- ---------------------------------------------------------------------------
-- 2. Barber earnings survive a customer's account deletion
-- ---------------------------------------------------------------------------
-- The published privacy policy promises that deleting an account removes that
-- customer's bookings and reviews, so those rows must still go. But the barber's
-- lifetime earnings and cut count are the barber's business record, and they
-- were being computed by summing Reservation rows — so one customer pressing
-- Delete Account silently reduced someone else's totals.
--
-- Deletion now rolls the completed appointments into these aggregate,
-- customer-free counters before removing the rows. Nothing personal is retained.
ALTER TABLE "Barber" ADD COLUMN "archivedCuts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Barber" ADD COLUMN "archivedEarnings" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 3. Retention sweep indexes
-- ---------------------------------------------------------------------------
-- RefreshToken rows were never deleted: with a 15-minute access TTL an active
-- device writes ~96 rows/day. Notification rows accumulate the same way (the
-- Barber-of-the-Week broadcast writes one per user per run). Both are now
-- trimmed nightly — these indexes keep that sweep cheap.
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- ---------------------------------------------------------------------------
-- 4. Nearby-shop search
-- ---------------------------------------------------------------------------
-- The app used to download the first 50 shops and measure distance on-device,
-- which stops being correct once more than 50 shops are live. GET
-- /api/shops/nearby now prefilters with a lat/lon bounding box in SQL.
CREATE INDEX "Barbershop_latitude_longitude_idx" ON "Barbershop"("latitude", "longitude");
-- Partial variant: almost every nearby query also requires coordinates to be
-- present, and skipping the NULL rows keeps this index small. Prisma cannot
-- express a partial index, so it lives only here (harmless drift — `migrate
-- diff` will not try to drop it, and the schema declares the full index above).
CREATE INDEX "Barbershop_geo_present_idx"
  ON "Barbershop"("latitude", "longitude")
  WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Trigram index for shop-name search
-- ---------------------------------------------------------------------------
-- GET /api/shops?search= runs ILIKE '%term%', which no btree index can serve.
-- pg_trgm is a trusted extension (PostgreSQL 13+), so this works on Render's
-- managed Postgres without superuser. Raw-only, like the partial index above.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Barbershop_name_trgm_idx" ON "Barbershop" USING gin ("name" gin_trgm_ops);
