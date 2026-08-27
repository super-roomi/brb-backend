-- Referral promo auto-expiry. Null = no expiry (current behavior). The
-- retention sweep zeroes referralDiscount once this passes.
ALTER TABLE "Barbershop" ADD COLUMN "discountExpiresAt" TIMESTAMP(3);
