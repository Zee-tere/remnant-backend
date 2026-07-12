import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReviewsService {
  constructor(private prisma: PrismaService) {}

  async submitReview(
    reviewerId: string,
    transactionId: string,
    rating: number,
    comment?: string,
  ) {
    if (rating < 1 || rating > 5) {
      throw new BadRequestException('Rating must be between 1 and 5');
    }

    const tx = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!tx) throw new NotFoundException('Transaction not found');
    if (tx.status !== 'COMPLETE') {
      throw new BadRequestException('Can only review completed transactions');
    }
    if (tx.buyerId !== reviewerId && tx.sellerId !== reviewerId) {
      throw new ForbiddenException('Not part of this transaction');
    }

    // Check if already reviewed
    const existing = await this.prisma.review.findUnique({ where: { transactionId } });
    if (existing) throw new BadRequestException('Transaction already reviewed');

    const revieweeId = tx.buyerId === reviewerId ? tx.sellerId : tx.buyerId;

    const review = await this.prisma.review.create({
      data: { transactionId, reviewerId, revieweeId, rating, comment },
    });

    // Recalculate trust tier
    await this.recalculateTrustTier(revieweeId);

    return review;
  }

  async getUserReviews(userId: string) {
    const reviews = await this.prisma.review.findMany({
      where: { revieweeId: userId },
      include: {
        reviewer: { select: { id: true, name: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const avgRating =
      reviews.length > 0
        ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
        : 0;

    return { reviews, averageRating: Math.round(avgRating * 10) / 10, totalReviews: reviews.length };
  }

  private async recalculateTrustTier(userId: string) {
    const completedTxCount = await this.prisma.transaction.count({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
        status: 'COMPLETE',
      },
    });

    const { averageRating } = await this.getUserReviews(userId);

    let trustTier: 'NEW' | 'VERIFIED' | 'TRUSTED' | 'POWER' = 'NEW';
    if (completedTxCount >= 25 && averageRating >= 4.5) trustTier = 'POWER';
    else if (completedTxCount >= 15 && averageRating >= 4.2) trustTier = 'TRUSTED';
    else if (completedTxCount >= 5 && averageRating >= 4.0) trustTier = 'VERIFIED';

    await this.prisma.user.update({
      where: { id: userId },
      data: { trustTier },
    });
  }
}
