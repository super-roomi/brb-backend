-- "Book for two" double booking.
--
-- One person books two back-to-back cuts (theirs + a friend's) in a single
-- action, both discounted. The two reservations share a groupId so they are
-- always shown, cancelled, and reasoned about as one booking. guestName carries
-- the friend's name onto the second cut so the barber knows who is in the chair.
--
-- Both columns are nullable and default to NULL, so every existing reservation
-- is untouched and behaves exactly as an ordinary single booking.
ALTER TABLE "Reservation" ADD COLUMN "groupId" TEXT;
ALTER TABLE "Reservation" ADD COLUMN "guestName" TEXT;

-- Loading "the other cut in this double" (barber views, group cancellation)
-- is a groupId lookup.
CREATE INDEX "Reservation_groupId_idx" ON "Reservation"("groupId");
