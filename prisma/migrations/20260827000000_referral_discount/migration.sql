-- "Bring a friend" referral discount.
--
-- Two customers who book the same shop and turn up together each get a flat
-- amount off. The amount is per shop and admin-controlled, and the barber
-- absorbs it (their earnings count price - discountAmount).

-- ---------------------------------------------------------------------------
-- 1. The promo itself: per-shop, off by default
-- ---------------------------------------------------------------------------
-- 0 means "this shop does not run the promo", so every existing shop stays
-- exactly as it is until an admin sets an amount and makes it live.
ALTER TABLE "Barbershop" ADD COLUMN "referralDiscount" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2. What a booking actually earned
-- ---------------------------------------------------------------------------
-- `price` keeps the original frozen-at-booking amount; this is what came off it.
-- Backfills to 0, so no historic booking or barber earning total moves.
ALTER TABLE "Reservation" ADD COLUMN "discountAmount" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 3. The pair
-- ---------------------------------------------------------------------------
-- Links the two bookings. `code` proves the two belong together (linkage); the
-- scan timestamps prove both were at the shop (presence). Both are required
-- before status becomes CONFIRMED and the discount is stamped.
CREATE TABLE "ReferralPair" (
  "id"                   TEXT NOT NULL,
  "code"                 TEXT NOT NULL,
  "shopId"               TEXT NOT NULL,
  "inviterReservationId" TEXT NOT NULL,
  "inviteeReservationId" TEXT,
  "status"               TEXT NOT NULL DEFAULT 'OPEN',
  "inviterScannedAt"     TIMESTAMP(3),
  "inviteeScannedAt"     TIMESTAMP(3),
  "discountAmount"       INTEGER NOT NULL,
  "codeExpiresAt"        TIMESTAMP(3) NOT NULL,
  "confirmedAt"          TIMESTAMP(3),
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReferralPair_pkey" PRIMARY KEY ("id")
);

-- The code is looked up on redemption, so uniqueness is both a correctness
-- guarantee (one pair per code) and the index that makes redemption cheap.
CREATE UNIQUE INDEX "ReferralPair_code_key" ON "ReferralPair"("code");
-- A reservation may sit on at most one side of at most one pair. These unique
-- constraints are what stop one booking being farmed across several friends.
CREATE UNIQUE INDEX "ReferralPair_inviterReservationId_key" ON "ReferralPair"("inviterReservationId");
CREATE UNIQUE INDEX "ReferralPair_inviteeReservationId_key" ON "ReferralPair"("inviteeReservationId");
CREATE INDEX "ReferralPair_shopId_status_idx" ON "ReferralPair"("shopId", "status");
CREATE INDEX "ReferralPair_status_codeExpiresAt_idx" ON "ReferralPair"("status", "codeExpiresAt");

ALTER TABLE "ReferralPair" ADD CONSTRAINT "ReferralPair_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Barbershop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralPair" ADD CONSTRAINT "ReferralPair_inviterReservationId_fkey"
  FOREIGN KEY ("inviterReservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralPair" ADD CONSTRAINT "ReferralPair_inviteeReservationId_fkey"
  FOREIGN KEY ("inviteeReservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. The QR payload
-- ---------------------------------------------------------------------------
-- Deliberately short-lived: this token IS the presence proof. A static or
-- long-lived code could be screenshotted and sent to a friend at home, which
-- would reduce "both are here" to "both own a phone". Minted from the barber's
-- authenticated session, so it is bound to one barber and one shop.
CREATE TABLE "ReferralToken" (
  "id"        TEXT NOT NULL,
  "token"     TEXT NOT NULL,
  "barberId"  TEXT NOT NULL,
  "shopId"    TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReferralToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReferralToken_token_key" ON "ReferralToken"("token");
-- Retention sweep deletes expired tokens; they are minted every ~45s per active
-- barber, so without this the table would grow indefinitely.
CREATE INDEX "ReferralToken_expiresAt_idx" ON "ReferralToken"("expiresAt");

ALTER TABLE "ReferralToken" ADD CONSTRAINT "ReferralToken_barberId_fkey"
  FOREIGN KEY ("barberId") REFERENCES "Barber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralToken" ADD CONSTRAINT "ReferralToken_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Barbershop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
