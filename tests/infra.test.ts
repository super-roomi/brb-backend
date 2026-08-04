import { describe, expect, it } from "vitest";
import { normalizeIp } from "../src/middleware/rateLimit.js";
import { withTimeout, TimeoutError } from "../src/lib/timeout.js";
import { signAccessToken, signAdminToken, verifyAccessToken, verifyAdminToken, peekUserId } from "../src/lib/jwt.js";
import { prisma } from "../src/lib/prisma.js";
import { runRetentionSweep } from "../src/services/maintenance.js";

describe("rate-limit keying", () => {
  it("passes IPv4 through unchanged", () => {
    expect(normalizeIp("203.0.113.7")).toBe("203.0.113.7");
  });

  it("unwraps IPv4-mapped IPv6", () => {
    expect(normalizeIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("collapses an IPv6 address to its /64 prefix", () => {
    // A client handed a whole /64 must not get a fresh bucket per address.
    const a = normalizeIp("2001:db8:abcd:1234:0000:0000:0000:0001");
    const b = normalizeIp("2001:db8:abcd:1234:ffff:ffff:ffff:ffff");
    expect(a).toBe(b);
    expect(a).toBe("2001:db8:abcd:1234::/64");
  });

  it("expands compressed IPv6 before taking the prefix", () => {
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8:0:0::/64");
    // Different /64s must stay in different buckets.
    expect(normalizeIp("2001:db8:1::1")).not.toBe(normalizeIp("2001:db8:2::1"));
  });

  it("strips a zone id", () => {
    expect(normalizeIp("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("never returns an empty key", () => {
    expect(normalizeIp("")).toBe("unknown");
  });
});

describe("external-call timeouts", () => {
  it("resolves a fast promise untouched", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1_000, "fast")).resolves.toBe("ok");
  });

  it("rejects with TimeoutError once the cap is hit", async () => {
    const hang = new Promise<never>(() => {}); // never settles
    await expect(withTimeout(hang, 20, "hang")).rejects.toBeInstanceOf(TimeoutError);
  });

  it("propagates the original rejection rather than masking it", async () => {
    const boom = Promise.reject(new Error("upstream said no"));
    await expect(withTimeout(boom, 1_000, "boom")).rejects.toThrow("upstream said no");
  });
});

describe("token separation", () => {
  it("does not accept a customer token as an admin token", () => {
    const userToken = signAccessToken({ sub: "user-1", role: "user" });
    expect(() => verifyAdminToken(userToken)).toThrow();
  });

  it("does not accept an admin token as a customer token", () => {
    const adminToken = signAdminToken("admin-1");
    expect(() => verifyAccessToken(adminToken)).toThrow();
  });

  it("still verifies each token against its own audience", () => {
    expect(verifyAccessToken(signAccessToken({ sub: "user-1", role: "user" })).sub).toBe("user-1");
    expect(verifyAdminToken(signAdminToken("admin-1")).sub).toBe("admin-1");
  });

  it("peekUserId reads a valid customer token and rejects everything else", () => {
    expect(peekUserId(signAccessToken({ sub: "user-9", role: "user" }))).toBe("user-9");
    // An unverified token must NOT produce a key, or anyone could mint
    // unlimited rate-limit buckets with random strings.
    expect(peekUserId("not-a-token")).toBeNull();
    expect(peekUserId(signAdminToken("admin-1"))).toBeNull();
    expect(peekUserId(undefined)).toBeNull();
  });
});

describe("retention sweep", () => {
  it("deletes expired refresh tokens and keeps live ones", async () => {
    const user = await prisma.user.create({
      data: { email: `retention-${Date.now()}@test.dev`, name: "Retention" },
    });
    const expired = await prisma.refreshToken.create({
      data: {
        tokenHash: `expired-${Date.now()}`,
        userId: user.id,
        expiresAt: new Date(Date.now() - 86_400_000),
      },
    });
    const live = await prisma.refreshToken.create({
      data: {
        tokenHash: `live-${Date.now()}`,
        userId: user.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    await runRetentionSweep();

    expect(await prisma.refreshToken.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await prisma.refreshToken.findUnique({ where: { id: live.id } })).not.toBeNull();
  });

  it("deletes notifications past the retention window and keeps recent ones", async () => {
    const user = await prisma.user.create({
      data: { email: `retention-notif-${Date.now()}@test.dev`, name: "Retention" },
    });
    // Default retention is 90 days.
    const old = await prisma.notification.create({
      data: {
        userId: user.id,
        type: "BOOKING_ACCEPTED",
        title: "old",
        body: "old",
        createdAt: new Date(Date.now() - 200 * 86_400_000),
      },
    });
    const recent = await prisma.notification.create({
      data: { userId: user.id, type: "BOOKING_ACCEPTED", title: "new", body: "new" },
    });

    await runRetentionSweep();

    expect(await prisma.notification.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.notification.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });

  it("never throws, so a background timer can't crash the process", async () => {
    await expect(runRetentionSweep()).resolves.toBeUndefined();
  });
});
