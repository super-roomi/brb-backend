-- Database-level backstop against double-booking a barber.
--
-- The application already serializes the capacity check + insert (Serializable
-- transaction + retry in services/booking.ts), but this constraint guarantees
-- correctness even if a future code path forgets to. A barber can never have
-- two slot-holding reservations (PENDING or CONFIRMED) whose time ranges
-- overlap. startsAt/endsAt are TIMESTAMP(3) (no time zone), so the range type
-- is tsrange, not tstzrange. The range is half-open [start, end): a booking
-- ending exactly when the next begins does NOT overlap.
--
-- Not enforced here: shops with zero barbers (barberId IS NULL) that rely on
-- chairCount. Those are covered by the application-level check only.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Reservation"
  ADD CONSTRAINT "no_barber_overlap"
  EXCLUDE USING gist (
    "barberId" WITH =,
    tsrange("startsAt", "endsAt") WITH &&
  )
  WHERE (status IN ('PENDING', 'CONFIRMED') AND "barberId" IS NOT NULL);
