import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

// Every other suite runs with limits disabled so it can hammer endpoints. This
// one opts the real limiters back in (see `skip` in middleware/rateLimit.ts) so
// the configured thresholds are genuinely exercised: without it, deleting a
// limiter from a login route would not fail a single test.
beforeAll(() => {
  process.env.TEST_RATE_LIMITS = "1";
});
afterAll(() => {
  delete process.env.TEST_RATE_LIMITS;
});

const app = createApp();

// The limiter runs before validation and before the handler, so these requests
// never reach Google/bcrypt — whatever non-429 status they get, what matters is
// that the ceiling eventually turns into a 429.
function post(path: string, body: object, ip: string) {
  return request(app).post(path).set("X-Forwarded-For", ip).send(body);
}

describe("login rate limiting", () => {
  it("throttles customer sign-in after the configured attempts", async () => {
    const ip = "203.0.113.10";
    const body = { idToken: "x".repeat(32) };

    // authLimiter allows 20 per 15 min per IP.
    const before = await post("/api/auth/google", body, ip);
    expect(before.status).not.toBe(429);

    let limited = false;
    for (let i = 0; i < 30 && !limited; i++) {
      const res = await post("/api/auth/google", body, ip);
      if (res.status === 429) {
        limited = true;
        expect(res.body.error.code).toBe("RATE_LIMITED");
      }
    }
    expect(limited).toBe(true);
  });

  it("throttles admin login harder than customer sign-in", async () => {
    const ip = "203.0.113.20";
    const body = { email: "admin@example.com", password: "wrong-password" };

    // adminLoginLimiter allows 10 per 15 min per IP — so a burst of 12 must be
    // cut off, proving the admin ceiling is tighter than the customer one (20).
    let limitedAt = -1;
    for (let i = 0; i < 12; i++) {
      const res = await post("/api/admin/login", body, ip);
      if (res.status === 429 && limitedAt === -1) limitedAt = i;
    }
    expect(limitedAt).toBeGreaterThan(-1);
    expect(limitedAt).toBeLessThan(12);
  });

  it("keys per IP, so one attacker cannot lock out another client", async () => {
    const attacker = "203.0.113.30";
    const bystander = "203.0.113.31";
    const body = { idToken: "x".repeat(32) };

    for (let i = 0; i < 25; i++) await post("/api/auth/google", body, attacker);
    expect((await post("/api/auth/google", body, attacker)).status).toBe(429);

    // A different IP still gets through — the limit is not global.
    expect((await post("/api/auth/google", body, bystander)).status).not.toBe(429);
  });
});
