-- Appointment reminders: mark when the ~20-minute reminder push was sent so the
-- scheduler never double-reminds. Index supports the sweep query (confirmed,
-- not-yet-reminded, starting soon).
ALTER TABLE "Reservation" ADD COLUMN "reminderSentAt" TIMESTAMP(3);
CREATE INDEX "Reservation_status_reminderSentAt_startsAt_idx"
  ON "Reservation" ("status", "reminderSentAt", "startsAt");
