// Shops store opening hours as minutes-from-local-midnight, and carry a fixed
// utcOffsetMinutes (Iraq is UTC+3 with no DST). Reservations are stored as UTC
// instants. These helpers convert between the two without a timezone library.

export function localDateToUtc(
  date: string, // YYYY-MM-DD in the shop's local calendar
  minuteOfDay: number,
  utcOffsetMinutes: number,
): Date {
  const [y, m, d] = date.split("-").map(Number);
  const utcMillis = Date.UTC(y, m - 1, d, 0, minuteOfDay - utcOffsetMinutes, 0);
  return new Date(utcMillis);
}

export function weekdayOfLocalDate(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  // Weekday of the calendar date itself (offset-independent).
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
}

export function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

// The [start, end) UTC instants bounding the shop-local calendar day that
// contains `now`. Used wherever "today" must mean the shop's day, not UTC's.
export function localDayRangeUtc(
  now: Date,
  utcOffsetMinutes: number,
): { dayStart: Date; dayEnd: Date } {
  const local = new Date(now.getTime() + utcOffsetMinutes * 60_000);
  const dayStart = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
      utcOffsetMinutes * 60_000,
  );
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000);
  return { dayStart, dayEnd };
}

// Add whole months, clamping the day to the target month's length so a period
// starting Jan 31 + 1 month lands on Feb 28/29 — never overflowing into March
// (which would silently gift the subscriber extra days).
export function addMonths(d: Date, months: number): Date {
  const result = new Date(d.getTime());
  const targetMonth = result.getMonth() + months;
  const day = result.getDate();
  result.setDate(1); // avoid overflow while we move the month
  result.setMonth(targetMonth);
  const daysInTargetMonth = new Date(
    result.getFullYear(),
    result.getMonth() + 1,
    0,
  ).getDate();
  result.setDate(Math.min(day, daysInTargetMonth));
  return result;
}
