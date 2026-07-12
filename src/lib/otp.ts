import crypto from "node:crypto";

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
// Max codes we'll send to one phone per rolling 24h. Blunts SMS-bombing a
// single victim number (the per-IP limiter is trivially spread across IPs).
export const OTP_DAILY_MAX = 10;
export const OTP_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function generateOtp(): string {
  // crypto-random 6 digits, no modulo bias worth worrying about at this range
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function hashOtp(phone: string, code: string): string {
  // Bind the hash to the phone so a code can't be replayed for another number.
  return crypto.createHash("sha256").update(`${phone}:${code}`).digest("hex");
}

export function verifyOtpHash(phone: string, code: string, hash: string): boolean {
  const candidate = hashOtp(phone, code);
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(hash));
}
