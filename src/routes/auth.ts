import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
import { verifyGoogleIdToken, type GoogleIdentity } from "../lib/googleAuth.js";
import { verifyAppleIdToken, type AppleIdentity } from "../lib/appleAuth.js";
import { hashToken, newRefreshToken, signAccessToken } from "../lib/jwt.js";
import { env } from "../env.js";
import { validate, parsed } from "../middleware/validate.js";
import { requireUser } from "../middleware/auth.js";
import { authLimiter } from "../middleware/rateLimit.js";

export const authRouter = Router();

// Email every developer test session shares (see /test-login).
export const TEST_USER_EMAIL = "tester@barberapp.dev";

const googleSchema = z.object({ idToken: z.string().min(20) });

// Sign in (or up) with a Google ID token obtained by the mobile app.
authRouter.post(
  "/google",
  authLimiter,
  validate(googleSchema),
  async (req, res) => {
    const { idToken } = parsed<z.infer<typeof googleSchema>>(req);
    const identity = await verifyGoogleIdToken(idToken);
    const { user, isNewUser } = await upsertGoogleUser(identity);

    const tokens = await issueTokens(user.id);
    res.json({
      ...tokens,
      isNewUser,
      user: { id: user.id, email: user.email, name: user.name },
    });
  },
);

const appleSchema = z.object({
  identityToken: z.string().min(20),
  // Apple returns the user's name only on the very first authorization, and
  // only to the client (never inside the token). The app forwards it here so we
  // can store it once; it is absent on every later sign-in.
  fullName: z.string().trim().min(1).max(60).optional(),
});

// Sign in (or up) with an Apple identity token obtained by the mobile app.
authRouter.post(
  "/apple",
  authLimiter,
  validate(appleSchema),
  async (req, res) => {
    const { identityToken, fullName } = parsed<z.infer<typeof appleSchema>>(req);
    const identity = await verifyAppleIdToken(identityToken);
    const { user, isNewUser } = await upsertAppleUser(identity, fullName ?? null);

    const tokens = await issueTokens(user.id);
    res.json({
      ...tokens,
      isNewUser,
      user: { id: user.id, email: user.email, name: user.name },
    });
  },
);

// Developer shortcut while Google credentials don't exist yet: logs in as a
// well-known test user with no external dependency. Hidden (404) in
// production unless ENABLE_TEST_LOGIN=true is set on purpose.
const testLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(120).optional(),
  name: z.string().trim().min(2).max(60).optional(),
});

authRouter.post(
  "/test-login",
  authLimiter,
  validate(testLoginSchema),
  async (req, res) => {
    if (!env.testLoginEnabled) throw ApiError.notFound();

    const body = parsed<z.infer<typeof testLoginSchema>>(req);
    const email = body.email ?? TEST_USER_EMAIL;
    const existing = await prisma.user.findUnique({ where: { email } });
    const user =
      existing ??
      (await prisma.user.create({
        data: { email, name: body.name ?? "Test User" },
      }));

    const tokens = await issueTokens(user.id);
    res.json({
      ...tokens,
      isNewUser: !existing,
      user: { id: user.id, email: user.email, name: user.name },
    });
  },
);

const refreshSchema = z.object({ refreshToken: z.string().min(20) });

authRouter.post("/refresh", validate(refreshSchema), async (req, res) => {
  const { refreshToken } = parsed<z.infer<typeof refreshSchema>>(req);
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
  });
  if (!record || record.expiresAt < new Date()) {
    throw ApiError.unauthorized("Session expired, sign in again", "REFRESH_INVALID");
  }

  // Atomically claim the token: only the first concurrent refresh flips
  // revokedAt from null, so two requests racing with the same token can't both
  // be issued a fresh pair (that would defeat rotation).
  const claimed = await prisma.refreshToken.updateMany({
    where: { id: record.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (claimed.count === 0) {
    // The token was already spent. Either a benign double-submit or a replay of
    // a stolen token — in both cases revoke the user's whole token family so a
    // thief can't keep using a newer token issued off the same lineage.
    await prisma.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw ApiError.unauthorized("Session expired, sign in again", "REFRESH_INVALID");
  }

  const tokens = await issueTokens(record.userId);
  res.json(tokens);
});

authRouter.post("/logout", validate(refreshSchema), async (req, res) => {
  const { refreshToken } = parsed<z.infer<typeof refreshSchema>>(req);
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
  res.json({ ok: true });
});

authRouter.get("/me", requireUser, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user) throw ApiError.unauthorized();
  res.json({ user: { id: user.id, email: user.email, name: user.name } });
});

const meSchema = z.object({ name: z.string().trim().min(2).max(60) });

authRouter.patch("/me", requireUser, validate(meSchema), async (req, res) => {
  const { name } = parsed<z.infer<typeof meSchema>>(req);
  const user = await prisma.user.update({
    where: { id: req.auth!.userId },
    data: { name },
  });
  res.json({ user: { id: user.id, email: user.email, name: user.name } });
});

// Account deletion, required in-app by App Store guideline 5.1.1(v). Removes
// the user and all their personal data. Reservation and Review reference User
// without a cascade, so delete those first; deleting the user then cascades
// its notifications, refresh tokens and device tokens. One transaction so a
// partial failure can't leave a half-deleted account behind.
authRouter.delete("/me", requireUser, async (req, res) => {
  const userId = req.auth!.userId;
  await prisma.$transaction([
    prisma.reservation.deleteMany({ where: { userId } }),
    prisma.review.deleteMany({ where: { userId } }),
    prisma.user.delete({ where: { id: userId } }),
  ]);
  res.json({ ok: true });
});

// Match order: googleId (stable even if the Google email changes), then email
// (links rows that predate this Google account, incl. "@phone.migrated" ones
// once the person's real email is set by an admin), then create.
async function upsertGoogleUser(identity: GoogleIdentity) {
  const byGoogleId = await prisma.user.findUnique({
    where: { googleId: identity.googleId },
  });
  if (byGoogleId) {
    if (byGoogleId.email !== identity.email || (!byGoogleId.name && identity.name)) {
      // Keep the stored email in sync with Google (barbers are linked by it).
      // If another row already holds the new email, keep the old one rather
      // than failing the login.
      const user = await prisma.user
        .update({
          where: { id: byGoogleId.id },
          data: {
            email: identity.email,
            name: byGoogleId.name ?? identity.name,
          },
        })
        .catch((e) => {
          if (isUniqueViolation(e)) return byGoogleId;
          throw e;
        });
      return { user, isNewUser: false };
    }
    return { user: byGoogleId, isNewUser: false };
  }

  const byEmail = await prisma.user.findUnique({ where: { email: identity.email } });
  if (byEmail) {
    const user = await prisma.user.update({
      where: { id: byEmail.id },
      data: { googleId: identity.googleId, name: byEmail.name ?? identity.name },
    });
    return { user, isNewUser: false };
  }

  try {
    const user = await prisma.user.create({
      data: {
        email: identity.email,
        googleId: identity.googleId,
        name: identity.name,
      },
    });
    return { user, isNewUser: true };
  } catch (e) {
    // Two first-logins racing: the loser refetches the winner's row.
    if (isUniqueViolation(e)) {
      const user = await prisma.user.findUnique({
        where: { googleId: identity.googleId },
      });
      if (user) return { user, isNewUser: false };
    }
    throw e;
  }
}

// Match order mirrors Google: appleId (stable even when the person hides their
// email), then email (links a row that already exists for the same real
// address — e.g. they used Google first), then create.
async function upsertAppleUser(identity: AppleIdentity, fullName: string | null) {
  const byAppleId = await prisma.user.findUnique({
    where: { appleId: identity.appleId },
  });
  if (byAppleId) {
    // Apple only ever sends the name once, so backfill it if we missed it then
    // (e.g. the first login failed after Apple had already consumed the name).
    if (!byAppleId.name && fullName) {
      const user = await prisma.user.update({
        where: { id: byAppleId.id },
        data: { name: fullName },
      });
      return { user, isNewUser: false };
    }
    return { user: byAppleId, isNewUser: false };
  }

  // No Apple link yet. We can only match or create when the token carried an
  // email, which it always does on the first authorization. A returning login
  // that omits the email must have matched by appleId above; if it didn't,
  // there is nothing to key on, so fail rather than orphan the account.
  if (!identity.email) {
    throw ApiError.unauthorized("Apple sign-in failed", "APPLE_TOKEN_INVALID");
  }

  const byEmail = await prisma.user.findUnique({ where: { email: identity.email } });
  if (byEmail) {
    const user = await prisma.user
      .update({
        where: { id: byEmail.id },
        data: { appleId: identity.appleId, name: byEmail.name ?? fullName },
      })
      .catch((e) => {
        if (isUniqueViolation(e)) return byEmail;
        throw e;
      });
    return { user, isNewUser: false };
  }

  try {
    const user = await prisma.user.create({
      data: {
        email: identity.email,
        appleId: identity.appleId,
        name: fullName,
      },
    });
    return { user, isNewUser: true };
  } catch (e) {
    // Two first-logins racing: the loser refetches the winner's row.
    if (isUniqueViolation(e)) {
      const user = await prisma.user.findUnique({
        where: { appleId: identity.appleId },
      });
      if (user) return { user, isNewUser: false };
    }
    throw e;
  }
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

async function issueTokens(userId: string) {
  const accessToken = signAccessToken({ sub: userId, role: "user" });
  const { token, hash } = newRefreshToken();
  await prisma.refreshToken.create({
    data: {
      tokenHash: hash,
      userId,
      expiresAt: new Date(Date.now() + env.refreshTtlDays * 86_400_000),
    },
  });
  return { accessToken, refreshToken: token };
}
