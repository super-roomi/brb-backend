import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { notifyUser } from "../lib/notify.js";
import { parseLang } from "../lib/localize.js";
import { referralDiscountEarned, referralFriendJoined } from "../lib/notificationMessages.js";
import { HOLDING_STATUSES } from "./booking.js";

// "Bring a friend": two customers who book the same shop and turn up together
// each get a flat amount off, absorbed by the barber.
//
// The feature has to survive people trying to claim money they haven't earned,
// so it proves two independent things by two different mechanisms:
//
//   LINKAGE  — these two bookings belong together. The inviter shares a
//              single-use code; the friend must book the SAME shop and redeem
//              it. Proves intent and acquaintance.
//   PRESENCE — both are at the shop, together, now. Both must scan the QR the
//              barber is showing (see mintBarberToken). A code alone proves
//              nothing about location: it can be redeemed from a sofa.
//
// Neither is sufficient alone, which is the point. Only when both hold does the
// discount stamp onto both bookings, atomically.

// How long a shared code stays redeemable. Long enough to text a friend and let
// them book, short enough that codes don't accumulate as a tradeable currency.
const CODE_TTL_MS = 24 * 60 * 60 * 1000;

// Lifetime of one QR token. This is the whole presence proof, so it is short: a
// screenshot has to be useless by the time it reaches someone not in the shop.
// The barber's app redraws well inside this window.
export const QR_TTL_MS = 60_000;

// Both scans must land within this of each other. Two people genuinely together
// scan seconds apart; this stops one person scanning now and a friend scanning
// when they wander in an hour later.
const SCAN_PAIRING_WINDOW_MS = 10 * 60_000;

// Unambiguous alphabet: no O/0, I/1, so a code read aloud or off a screen can't
// be mistyped into someone else's code.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

function newCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

// A booking can still earn a discount while it is pending or confirmed and has
// not finished. Anything else (cancelled, declined, already over) cannot.
function isLive(r: { status: string; endsAt: Date }): boolean {
  return HOLDING_STATUSES.includes(r.status) && r.endsAt.getTime() > Date.now();
}

export interface PairView {
  code: string;
  status: string;
  discountAmount: number;
  friendJoined: boolean;
  youScanned: boolean;
  friendScanned: boolean;
  codeExpiresAt: string;
}

function viewFor(
  pair: {
    code: string;
    status: string;
    discountAmount: number;
    inviteeReservationId: string | null;
    inviterScannedAt: Date | null;
    inviteeScannedAt: Date | null;
    codeExpiresAt: Date;
  },
  asInviter: boolean,
): PairView {
  return {
    code: pair.code,
    status: pair.status,
    discountAmount: pair.discountAmount,
    friendJoined: pair.inviteeReservationId !== null,
    youScanned: (asInviter ? pair.inviterScannedAt : pair.inviteeScannedAt) !== null,
    friendScanned: (asInviter ? pair.inviteeScannedAt : pair.inviterScannedAt) !== null,
    codeExpiresAt: pair.codeExpiresAt.toISOString(),
  };
}

/**
 * Issue an invite code against the caller's booking.
 *
 * Idempotent: asking twice returns the same code rather than minting a second
 * one, so a customer tapping "invite a friend" repeatedly cannot hand out codes
 * that each carry their own discount.
 */
export async function createInvite(userId: string, reservationId: string): Promise<PairView> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: {
      shop: { select: { referralDiscount: true } },
      referralAsInviter: true,
      referralAsInvitee: true,
    },
  });
  if (!reservation || reservation.userId !== userId) {
    throw ApiError.notFound("Reservation not found");
  }
  if (reservation.referralAsInviter) {
    return viewFor(reservation.referralAsInviter, true);
  }
  // Already someone else's guest — a booking earns the discount once.
  if (reservation.referralAsInvitee) {
    throw ApiError.conflict(
      "This booking is already part of a referral.",
      "ALREADY_IN_REFERRAL",
    );
  }
  if (!isLive(reservation)) {
    throw ApiError.badRequest("This booking can no longer earn a referral discount", "BOOKING_NOT_LIVE");
  }
  const discountAmount = reservation.shop.referralDiscount;
  if (discountAmount <= 0) {
    throw ApiError.badRequest(
      "This barbershop is not running the bring-a-friend offer",
      "REFERRAL_NOT_AVAILABLE",
    );
  }

  // Snapshot the amount now: an admin retuning the shop's promo later must not
  // change what these two were already promised.
  for (let attempt = 0; ; attempt++) {
    try {
      const pair = await prisma.referralPair.create({
        data: {
          code: newCode(),
          shopId: reservation.shopId,
          inviterReservationId: reservation.id,
          discountAmount,
          codeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
        },
      });
      return viewFor(pair, true);
    } catch (e) {
      // Astronomically unlikely code collision — just draw again.
      if (
        attempt < 3 &&
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002" &&
        String(e.meta?.target ?? "").includes("code")
      ) {
        continue;
      }
      throw e;
    }
  }
}

/**
 * Redeem a friend's code against the caller's booking.
 *
 * This establishes LINKAGE only. No discount is applied here — both people
 * still have to scan the barber's QR at the shop.
 */
export async function joinInvite(
  userId: string,
  reservationId: string,
  rawCode: string,
): Promise<PairView> {
  const code = rawCode.trim().toUpperCase();
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { referralAsInviter: true, referralAsInvitee: true },
  });
  if (!reservation || reservation.userId !== userId) {
    throw ApiError.notFound("Reservation not found");
  }
  if (reservation.referralAsInviter || reservation.referralAsInvitee) {
    throw ApiError.conflict("This booking is already part of a referral.", "ALREADY_IN_REFERRAL");
  }
  if (!isLive(reservation)) {
    throw ApiError.badRequest("This booking can no longer earn a referral discount", "BOOKING_NOT_LIVE");
  }

  const pair = await prisma.referralPair.findUnique({
    where: { code },
    include: { inviterReservation: { select: { userId: true, status: true, endsAt: true } } },
  });
  // One message for "wrong code" and "expired code" alike: distinguishing them
  // would let someone probe which codes exist.
  const unusable =
    !pair ||
    pair.status !== "OPEN" ||
    pair.codeExpiresAt.getTime() < Date.now() ||
    !isLive(pair.inviterReservation);
  if (unusable) {
    throw ApiError.badRequest("That code is not valid any more", "REFERRAL_CODE_INVALID");
  }
  if (pair.shopId !== reservation.shopId) {
    throw ApiError.badRequest(
      "That code belongs to a different barbershop",
      "REFERRAL_WRONG_SHOP",
    );
  }
  // The whole promo is "bring a friend". One person with two accounts is not a
  // friend, and the barber cannot tell the accounts apart at the chair — so
  // reject it here, where identity is actually known.
  if (pair.inviterReservation.userId === userId) {
    throw ApiError.badRequest("You cannot use your own code", "REFERRAL_SELF");
  }

  // Claim the pair only while it is still OPEN, so two friends racing the same
  // code cannot both join.
  const claimed = await prisma.referralPair.updateMany({
    where: { id: pair.id, status: "OPEN", inviteeReservationId: null },
    data: { inviteeReservationId: reservation.id, status: "PENDING" },
  });
  if (claimed.count === 0) {
    throw ApiError.badRequest("That code is not valid any more", "REFERRAL_CODE_INVALID");
  }

  const updated = await prisma.referralPair.findUniqueOrThrow({ where: { id: pair.id } });

  // Tell the inviter their friend is in.
  void (async () => {
    try {
      const inviter = await prisma.user.findUnique({
        where: { id: pair.inviterReservation.userId },
        select: { id: true, lang: true },
      });
      const friend = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
      if (!inviter) return;
      const lang = parseLang(inviter.lang);
      await notifyUser({
        userId: inviter.id,
        type: "REFERRAL_JOINED",
        reservationId: pair.inviterReservationId,
        lang,
        build: (l) => referralFriendJoined(l, { friend: friend?.name?.trim() || null }),
      });
    } catch (err) {
      logger.error({ err }, "referral join notify failed");
    }
  })();

  return viewFor(updated, false);
}

/**
 * Mint the short-lived token behind the barber's QR.
 *
 * Bound to the barber's shop because it is minted from their authenticated
 * session — that binding is what makes a scan mean "at THIS shop" rather than
 * "somewhere, holding a code".
 */
export async function mintBarberToken(barberId: string, shopId: string) {
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + QR_TTL_MS);
  await prisma.referralToken.create({ data: { token, barberId, shopId, expiresAt } });
  return { token, expiresAt };
}

export interface ScanResult {
  pair: PairView;
  /** True when this scan completed the pair and the discount was applied. */
  discountApplied: boolean;
}

/**
 * Record one customer's scan of a barber's QR, and apply the discount once both
 * halves of the pair have scanned.
 *
 * This is the PRESENCE half. Everything that makes the discount real happens
 * here, inside one serializable transaction.
 */
export async function recordScan(
  userId: string,
  reservationId: string,
  rawToken: string,
): Promise<ScanResult> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { referralAsInviter: true, referralAsInvitee: true },
  });
  if (!reservation || reservation.userId !== userId) {
    throw ApiError.notFound("Reservation not found");
  }
  const pairRow = reservation.referralAsInviter ?? reservation.referralAsInvitee;
  if (!pairRow) {
    throw ApiError.badRequest("This booking is not part of a referral", "NO_REFERRAL");
  }
  const asInviter = reservation.referralAsInviter !== null;

  const token = await prisma.referralToken.findUnique({ where: { token: rawToken } });
  if (!token || token.expiresAt.getTime() < Date.now()) {
    // Covers both a forged token and a screenshot that has aged out — which is
    // exactly the attack the short TTL exists to defeat.
    throw ApiError.badRequest(
      "That code has expired. Ask the barber to show it again.",
      "QR_EXPIRED",
    );
  }
  // Scanning some other shop's QR proves presence at the wrong place.
  if (token.shopId !== pairRow.shopId) {
    throw ApiError.badRequest(
      "That code belongs to a different barbershop",
      "REFERRAL_WRONG_SHOP",
    );
  }
  if (pairRow.status === "CONFIRMED") {
    return { pair: viewFor(pairRow, asInviter), discountApplied: false };
  }
  if (pairRow.status !== "PENDING") {
    throw ApiError.badRequest(
      "Your friend has not joined with your code yet",
      "REFERRAL_INCOMPLETE",
    );
  }

  const now = new Date();
  const result = await prisma.$transaction(
    async (tx) => {
      const pair = await tx.referralPair.findUniqueOrThrow({ where: { id: pairRow.id } });
      if (pair.status !== "PENDING") {
        return { pair, applied: false };
      }

      const mineAt = asInviter ? pair.inviterScannedAt : pair.inviteeScannedAt;
      const theirsAt = asInviter ? pair.inviteeScannedAt : pair.inviterScannedAt;
      const stampedAt = mineAt ?? now;

      // Both present only counts if the two scans are close together. A stale
      // first scan is refreshed rather than rejected, so the pair can simply
      // re-scan together instead of being locked out.
      const bothClose =
        theirsAt !== null &&
        Math.abs(stampedAt.getTime() - theirsAt.getTime()) <= SCAN_PAIRING_WINDOW_MS;
      const effectiveMine = theirsAt !== null && !bothClose ? now : stampedAt;
      const complete =
        theirsAt !== null &&
        Math.abs(effectiveMine.getTime() - theirsAt.getTime()) <= SCAN_PAIRING_WINDOW_MS;

      const updated = await tx.referralPair.update({
        where: { id: pair.id },
        data: {
          ...(asInviter
            ? { inviterScannedAt: effectiveMine }
            : { inviteeScannedAt: effectiveMine }),
          ...(complete ? { status: "CONFIRMED", confirmedAt: now } : {}),
        },
      });

      if (!complete) return { pair: updated, applied: false };

      // Both here: stamp the discount on both bookings together. Guarded on
      // discountAmount still being 0 so a replay cannot discount twice.
      await tx.reservation.updateMany({
        where: {
          id: { in: [pair.inviterReservationId, pair.inviteeReservationId!] },
          discountAmount: 0,
        },
        data: { discountAmount: pair.discountAmount },
      });
      return { pair: updated, applied: true };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000 },
  );

  if (result.applied) void notifyBothOfDiscount(result.pair);
  return { pair: viewFor(result.pair, asInviter), discountApplied: result.applied };
}

async function notifyBothOfDiscount(pair: {
  inviterReservationId: string;
  inviteeReservationId: string | null;
  discountAmount: number;
}): Promise<void> {
  try {
    const ids = [pair.inviterReservationId, pair.inviteeReservationId].filter(
      (v): v is string => v !== null,
    );
    const rows = await prisma.reservation.findMany({
      where: { id: { in: ids } },
      select: { id: true, userId: true, user: { select: { lang: true } } },
    });
    for (const r of rows) {
      const lang = parseLang(r.user.lang);
      await notifyUser({
        userId: r.userId,
        type: "REFERRAL_DISCOUNT",
        reservationId: r.id,
        lang,
        build: (l) => referralDiscountEarned(l, { amount: pair.discountAmount, lang }),
      });
    }
  } catch (err) {
    logger.error({ err }, "referral discount notify failed");
  }
}

/**
 * Void a pair when one of its bookings falls through, so the other person is
 * not left holding a code that can never complete. Best-effort by design: a
 * cancellation must never fail because of promo bookkeeping.
 */
export async function voidPairForReservation(reservationId: string): Promise<void> {
  try {
    await prisma.referralPair.updateMany({
      where: {
        OR: [{ inviterReservationId: reservationId }, { inviteeReservationId: reservationId }],
        status: { in: ["OPEN", "PENDING"] },
      },
      data: { status: "VOID" },
    });
  } catch (err) {
    logger.error({ err, reservationId }, "referral pair void failed");
  }
}

/** The caller's referral state for a booking, or null when there is none. */
export async function pairForReservation(
  userId: string,
  reservationId: string,
): Promise<PairView | null> {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { referralAsInviter: true, referralAsInvitee: true },
  });
  if (!reservation || reservation.userId !== userId) {
    throw ApiError.notFound("Reservation not found");
  }
  if (reservation.referralAsInviter) return viewFor(reservation.referralAsInviter, true);
  if (reservation.referralAsInvitee) return viewFor(reservation.referralAsInvitee, false);
  return null;
}
