import rateLimit from "express-rate-limit";
import { env } from "../env.js";

// In-memory stores: correct for a single node. Behind a load balancer swap in
// a Redis store (rate-limit-redis) so limits are shared across instances.

const skip = () => env.isTest;

export const generalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
});

// Strict: OTP requests cost money (SMS) and are the main abuse target.
export const otpRequestLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  message: { error: { code: "RATE_LIMITED", message: "Too many OTP requests. Try again later." } },
});

export const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  message: { error: { code: "RATE_LIMITED", message: "Too many attempts. Try again later." } },
});

// Admin login is a single high-value credential; throttle it hard so the
// bcrypt cost isn't the only thing standing between an attacker and the panel.
export const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  message: { error: { code: "RATE_LIMITED", message: "Too many login attempts. Try again later." } },
});
