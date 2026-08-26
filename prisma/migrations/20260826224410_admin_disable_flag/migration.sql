-- Disabled admins keep their row (audit trail references it) but cannot log in.
ALTER TABLE "AdminUser" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;
