import { ApiError } from "./errors.js";

// E.164: +, then 8–15 digits, first digit non-zero.
const E164 = /^\+[1-9]\d{7,14}$/;

export function normalizePhone(raw: string): string {
  const cleaned = raw.replace(/[\s\-()]/g, "");
  if (!E164.test(cleaned)) {
    throw ApiError.badRequest(
      "Phone must be in international format, e.g. +9647501234567",
      "INVALID_PHONE",
    );
  }
  return cleaned;
}
