import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
import { normalizePhone } from "../lib/phone.js";
import {
  generateOtp,
  hashOtp,
  verifyOtpHash,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
} from "../lib/otp.js";
import { hashToken, newRefreshToken, signAccessToken } from "../lib/jwt.js";
import { sms } from "../lib/sms.js";
import { env } from "../env.js";
import { validate, parsed } from "../middleware/validate.js";
import { requireUser } from "../middleware/auth.js";
import { otpRequestLimiter, otpVerifyLimiter } from "../middleware/rateLimit.js";

export const authRouter = Router();

const requestSchema = z.object({ phone: z.string().min(8).max(20) });

authRouter.post(
  "/otp/request",
  otpRequestLimiter,
  validate(requestSchema),
  async (req, res) => {
    const phone = normalizePhone(parsed<z.infer<typeof requestSchema>>(req).phone);

    const latest = await prisma.otpRequest.findFirst({
      where: { phone },
      orderBy: { createdAt: "desc" },
    });
    if (latest && Date.now() - latest.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
      throw ApiError.tooMany("Please wait a minute before requesting another code");
    }

    const code = generateOtp();
    const request = await prisma.otpRequest.create({
      data: {
        phone,
        codeHash: hashOtp(phone, code),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });
    await sms.send(phone, `Your Barber App verification code is ${code}`);

    res.json({
      requestId: request.id,
      expiresInSeconds: OTP_TTL_MS / 1000,
      // Dev convenience only — never present in production responses.
      ...(!env.isProd && env.smsProvider === "console" ? { devCode: code } : {}),
    });
  },
);

const verifySchema = z.object({
  requestId: z.string(),
  phone: z.string().min(8).max(20),
  code: z.string().regex(/^\d{6}$/, "6-digit code"),
  name: z.string().trim().min(2).max(60).optional(),
});

authRouter.post(
  "/otp/verify",
  otpVerifyLimiter,
  validate(verifySchema),
  async (req, res) => {
    const body = parsed<z.infer<typeof verifySchema>>(req);
    const phone = normalizePhone(body.phone);

    const request = await prisma.otpRequest.findUnique({ where: { id: body.requestId } });
    if (!request || request.phone !== phone) {
      throw ApiError.badRequest("Invalid verification request", "OTP_INVALID");
    }
    if (request.consumedAt) throw ApiError.badRequest("Code already used", "OTP_USED");
    if (request.expiresAt < new Date()) {
      throw ApiError.badRequest("Code expired, request a new one", "OTP_EXPIRED");
    }
    if (request.attempts >= OTP_MAX_ATTEMPTS) {
      throw ApiError.tooMany("Too many wrong attempts, request a new code", "OTP_LOCKED");
    }

    if (!verifyOtpHash(phone, body.code, request.codeHash)) {
      await prisma.otpRequest.update({
        where: { id: request.id },
        data: { attempts: { increment: 1 } },
      });
      throw ApiError.badRequest("Wrong code", "OTP_WRONG");
    }

    await prisma.otpRequest.update({
      where: { id: request.id },
      data: { consumedAt: new Date() },
    });

    const existing = await prisma.user.findUnique({ where: { phone } });
    const user =
      existing ??
      (await prisma.user.create({ data: { phone, name: body.name ?? null } }));
    if (existing && body.name) {
      await prisma.user.update({ where: { id: user.id }, data: { name: body.name } });
    }

    const tokens = await issueTokens(user.id);
    res.json({
      ...tokens,
      isNewUser: !existing,
      user: { id: user.id, phone: user.phone, name: body.name ?? user.name },
    });
  },
);

const refreshSchema = z.object({ refreshToken: z.string().min(20) });

authRouter.post("/refresh", validate(refreshSchema), async (req, res) => {
  const { refreshToken } = parsed<z.infer<typeof refreshSchema>>(req);
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
  });
  if (!record || record.revokedAt || record.expiresAt < new Date()) {
    throw ApiError.unauthorized("Session expired, sign in again", "REFRESH_INVALID");
  }
  // Rotation: the old token dies with each refresh, so a stolen token stops
  // working as soon as either party uses it.
  await prisma.refreshToken.update({
    where: { id: record.id },
    data: { revokedAt: new Date() },
  });
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
  res.json({ user: { id: user.id, phone: user.phone, name: user.name } });
});

const meSchema = z.object({ name: z.string().trim().min(2).max(60) });

authRouter.patch("/me", requireUser, validate(meSchema), async (req, res) => {
  const { name } = parsed<z.infer<typeof meSchema>>(req);
  const user = await prisma.user.update({
    where: { id: req.auth!.userId },
    data: { name },
  });
  res.json({ user: { id: user.id, phone: user.phone, name: user.name } });
});

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
