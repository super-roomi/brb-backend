import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireUser } from "../middleware/auth.js";

export const notificationsRouter = Router();
notificationsRouter.use(requireUser);

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
