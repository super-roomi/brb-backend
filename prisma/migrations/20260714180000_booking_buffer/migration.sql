-- Grace period (minutes) between consecutive bookings for the same barber/chair.
ALTER TABLE "Barbershop" ADD COLUMN "bufferMin" INTEGER NOT NULL DEFAULT 0;
