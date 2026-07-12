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
