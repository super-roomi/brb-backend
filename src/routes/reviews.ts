import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ApiError } from "../lib/errors.js";
import { requireUser } from "../middleware/auth.js";
import { validate, parsed } from "../middleware/validate.js";

export const reviewsRouter = Router();

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().min(3).max(1000),
});

// PUT = create or replace the caller's single review for the shop.
reviewsRouter.put(
  "/shops/:id/review",
  requireUser,
  validate(reviewSchema),
  async (req, res) => {
    const { rating, comment } = parsed<z.infer<typeof reviewSchema>>(req);
    const userId = req.auth!.userId;
    const shopId = req.params.id;

    const shop = await prisma.barbershop.findUnique({ where: { id: shopId } });
    if (!shop) throw ApiError.notFound("Barbershop not found");

    // Reviews are gated on a completed visit: a confirmed reservation whose
    // end time has passed.
    const visits = await prisma.reservation.count({
      where: { userId, shopId, status: "CONFIRMED", endsAt: { lt: new Date() } },
    });
    if (visits === 0) {
      throw ApiError.forbidden(
        "You can review a barbershop after a completed visit",
        "REVIEW_REQUIRES_VISIT",
      );
    }

    // Upsert the review and refresh the shop's denormalized aggregate in the
    // same transaction so list ordering never drifts from the truth.
    const review = await prisma.$transaction(async (tx) => {
      const saved = await tx.review.upsert({
        where: { userId_shopId: { userId, shopId } },
        create: { userId, shopId, rating, comment },
        update: { rating, comment },
      });
      const agg = await tx.review.aggregate({
        where: { shopId },
        _avg: { rating: true },
        _count: true,
      });
      await tx.barbershop.update({
        where: { id: shopId },
        data: {
          ratingAvg: Math.round((agg._avg.rating ?? 0) * 10) / 10,
          ratingCount: agg._count,
        },
      });
      return saved;
    });

    res.json({
      review: {
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt.toISOString(),
      },
    });
  },
);
