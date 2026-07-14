-- "Barber of the Week" curated feature slots (rank 1..3) + selection timestamp.
ALTER TABLE "Barbershop" ADD COLUMN "botwRank" INTEGER;
ALTER TABLE "Barbershop" ADD COLUMN "botwSelectedAt" TIMESTAMP(3);
