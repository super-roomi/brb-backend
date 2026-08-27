import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";
import { env } from "../env.js";
import { peekUserId } from "../lib/jwt.js";
import { bearerToken } from "./auth.js";

// In-memory stores: correct for a single instance. Behind more than one, swap
// in a Redis store (rate-limit-redis) so limits are shared — with N instances
// the effective limit is currently N x the configured value, and which bucket a
// caller lands in depends on which instance the load balancer picked.

// Limits are off under test so the suites can hammer endpoints freely. The
// rate-limit suite opts back in with TEST_RATE_LIMITS=1 so the real thresholds
// are actually exercised — without that, removing a limiter from a login route
// or raising its ceiling would not fail a single test. Read per request rather
// than captured at import, so a suite can enable it without import-order games.
const skip = () => env.isTest && process.env.TEST_RATE_LIMITS !== "1";

// Collapse an IPv6 address to its /64 prefix. A single IPv6 client is routinely
// handed a whole /64, so keying on the full address would let it walk its own
// subnet for a fresh bucket per request. IPv4 (including v4-mapped) is returned
// unchanged — those are allocated one address at a time.
export function normalizeIp(ip: string): string {
  if (!ip) return "unknown";
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Mapped) return v4Mapped[1];
  if (!ip.includes(":")) return ip; // plain IPv4
  const [addr] = ip.split("%"); // strip any zone id
  const [head, tail = ""] = addr.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const full = addr.includes("::")
    ? [...headParts, ...Array(Math.max(missing, 0)).fill("0"), ...tailParts]
    : headParts;
  return full.slice(0, 4).map((h) => (h || "0").toLowerCase()).join(":") + "::/64";
}

// Iraqi mobile carriers put very large user populations behind a handful of
// CGNAT addresses, so a purely IP-keyed limit means one busy carrier can
// exhaust the bucket for everyone on it — the realistic failure is "the app
// broke for every customer on one carrier during a promo", not "attacker
// throttled".
//
// So: key authenticated traffic on the user id, and only fall back to IP for
// anonymous callers. The token is verified (not just hashed) — keying on an
// unverified bearer string would let anyone mint unlimited buckets by sending
// random tokens, which is a bypass rather than a limit.
function userOrIpKey(req: Request, _res: Response): string {
  const userId = peekUserId(bearerToken(req));
  if (userId) return `u:${userId}`;
  return `ip:${normalizeIp(req.ip ?? "")}`;
}

export const generalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  skip,
});

// Login endpoints (/auth/google, /auth/apple): each hit costs an external token
// verification and can mint sessions, so keep it well below the general limiter
// while allowing normal retry behaviour. IP-keyed by definition — there is no
// authenticated identity yet.
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `auth:${normalizeIp(req.ip ?? "")}`,
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
  keyGenerator: (req: Request) => `admin:${normalizeIp(req.ip ?? "")}`,
  skip,
  message: { error: { code: "RATE_LIMITED", message: "Too many login attempts. Try again later." } },
});
