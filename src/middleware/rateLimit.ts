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

// Login endpoints (/auth/google, /auth/test-login): each hit costs a Google
// token verification and can mint sessions, so keep it well below the general
// limiter while allowing normal retry behaviour.
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip,
  message: { error: { code: "RATE_LIMITED", message: "Too many sign-in attempts. Try again later." } },
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
