-- Login moves from phone+OTP to Google OAuth. Identity column becomes the
-- Google account email; existing phone values are preserved as
-- "<phone>@phone.migrated" placeholders so rows (and barber linkage, which
-- matches User.email = Barber.email) survive until each person signs in with
-- Google and gets linked by their real email.

-- Users: phone -> email, plus the stable Google account id.
ALTER TABLE "User" RENAME COLUMN "phone" TO "email";
UPDATE "User" SET "email" = "email" || '@phone.migrated';
ALTER INDEX "User_phone_key" RENAME TO "User_email_key";
ALTER TABLE "User" ADD COLUMN "googleId" TEXT;
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");

-- Barbers link to users by email now (was phone).
ALTER TABLE "Barber" RENAME COLUMN "phone" TO "email";
UPDATE "Barber" SET "email" = "email" || '@phone.migrated';
ALTER INDEX "Barber_phone_key" RENAME TO "Barber_email_key";

-- OTP flow is gone.
DROP TABLE "OtpRequest";
