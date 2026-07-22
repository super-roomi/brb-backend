import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireUser } from "../middleware/auth.js";
import { validate, parsed } from "../middleware/validate.js";
import { parseLang } from "../lib/localize.js";

export const notificationsRouter = Router();
notificationsRouter.use(requireUser);

const deviceSchema = z.object({
  token: z.string().min(10).max(500),
  platform: z.enum(["android", "ios"]).default("android"),
});

// Register (or refresh) this device's FCM token for the logged-in user. The
// token is globally unique; if it was previously registered to another user
// (shared device), it's reassigned to the current user.
notificationsRouter.post("/device", validate(deviceSchema), async (req, res) => {
  const { token, platform } = parsed<z.infer<typeof deviceSchema>>(req);
  const userId = req.auth!.userId;
  await prisma.deviceToken.upsert({
    where: { token },
    create: { userId, token, platform },
    update: { userId, platform },
  });
  // The device-register request carries the app's current ?lang=; remember it
  // so notifications sent later (outside the user's request) are localized.
  await prisma.user
    .update({ where: { id: userId }, data: { lang: parseLang(req.query.lang) } })
    .catch(() => {});
  res.json({ ok: true });
});

// Unregister a device token (called on logout).
const unregisterSchema = z.object({ token: z.string() });
notificationsRouter.post("/device/unregister", validate(unregisterSchema), async (req, res) => {
  const { token } = parsed<z.infer<typeof unregisterSchema>>(req);
  await prisma.deviceToken.deleteMany({ where: { token, userId: req.auth!.userId } });
  res.json({ ok: true });
});

// In-app notification feed. The client polls this (on launch / when opening
// the bookings tab) to surface booking accept/decline outcomes. Real push
// (APNs/FCM) would layer on top of the same Notification records.
notificationsRouter.get("/", async (req, res) => {
  const userId = req.auth!.userId;
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  res.json({
    unread,
    notifications: items.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      reservationId: n.reservationId,
      read: n.readAt !== null,
      createdAt: n.createdAt.toISOString(),
    })),
  });
});

notificationsRouter.post("/read", async (req, res) => {
  await prisma.notification.updateMany({
    where: { userId: req.auth!.userId, readAt: null },
    data: { readAt: new Date() },
  });
  res.json({ ok: true });
});
