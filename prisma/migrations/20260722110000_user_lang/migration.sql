-- Store each user's preferred language so notifications (sent outside the
-- user's own request) can be localized. Refreshed from the ?lang= the app
-- sends when registering its device token.
ALTER TABLE "User" ADD COLUMN "lang" TEXT NOT NULL DEFAULT 'en';
