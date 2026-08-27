-- The display name is now chosen once at first login and then locked.
-- New column defaults to false, but every EXISTING account already has a name
-- and must never be re-prompted or locked out, so backfill them to true.
ALTER TABLE "User" ADD COLUMN "nameChosen" BOOLEAN NOT NULL DEFAULT false;

UPDATE "User" SET "nameChosen" = true;
