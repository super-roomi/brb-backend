-- Optional per-language translations for admin-entered content. Base name/
-- description stay English (fallback); the app shows the Ar/Ckb value when the
-- user picks that language and it's set.
ALTER TABLE "Barbershop" ADD COLUMN "nameAr" TEXT;
ALTER TABLE "Barbershop" ADD COLUMN "nameCkb" TEXT;
ALTER TABLE "Barbershop" ADD COLUMN "descriptionAr" TEXT;
ALTER TABLE "Barbershop" ADD COLUMN "descriptionCkb" TEXT;
ALTER TABLE "Service" ADD COLUMN "nameAr" TEXT;
ALTER TABLE "Service" ADD COLUMN "nameCkb" TEXT;
ALTER TABLE "Barber" ADD COLUMN "nameAr" TEXT;
ALTER TABLE "Barber" ADD COLUMN "nameCkb" TEXT;
