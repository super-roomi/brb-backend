import { ApiError } from "./errors.js";

// E.164: +, then 8–15 digits, first digit non-zero.
const E164 = /^\+[1-9]\d{7,14}$/;

export function normalizePhone(raw: string): string {
  const cleaned = tryNormalizePhone(raw);
  if (!cleaned) {
    throw ApiError.badRequest(
      "Phone must be in international format, e.g. +9647501234567",
      "INVALID_PHONE",
    );
  }
  return cleaned;
}

// Non-throwing variant for use inside Zod schemas (barber phones): strips
// spacing/punctuation and returns canonical E.164, or null when the number
// can't be coerced to E.164. Storing the canonical form is what lets a barber's
// login phone match their Barber row exactly.
export function tryNormalizePhone(raw: string): string | null {
  const cleaned = raw.replace(/[\s\-()]/g, "");
  return E164.test(cleaned) ? cleaned : null;
}
