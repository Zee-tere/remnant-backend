import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateUserDto } from './user.dto';

const SAFE_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  avatarUrl: true,
  bio: true,
  city: true,
  role: true,
  trustTier: true,
  points: true,
  emailVerified: true,
  createdAt: true,
  updatedAt: true,
};

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) {}

  async getUserById(id: string, includePrivate = false) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        ...(includePrivate
          ? SAFE_USER_SELECT
          : {
              id: true,
              name: true,
              avatarUrl: true,
              bio: true,
              city: true,
              trustTier: true,
              points: true,
              createdAt: true,
            }),
        _count: {
          select: {
            listings: true,
            reviewsReceived: true,
          },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateUser(id: string, data: UpdateUserDto) {
    return this.prisma.user.update({
      where: { id },
      data,
      select: SAFE_USER_SELECT,
    });
  }

  async getDashboardSummary(userId: string) {
    const [listings, activeListings, unreadAlerts, pendingMatches, unreadMessages] = await Promise.all([
      this.prisma.listing.count({ where: { userId } }),
      this.prisma.listing.count({ where: { userId, status: 'ACTIVE' } }),
      this.prisma.notification.count({ where: { userId, isRead: false } }),
      this.prisma.match.count({
        where: {
          status: 'PENDING',
          OR: [{ listingA: { userId } }, { listingB: { userId } }],
        },
      }),
      this.prisma.conversation.count({
        where: {
          OR: [{ buyerId: userId }, { sellerId: userId }],
          messages: { some: { senderId: { not: userId }, readAt: null } },
        },
      }),
    ]);

    return { listings, activeListings, unreadAlerts, pendingMatches, unreadMessages };
  }

  async getAchievements(userId: string) {
    const achievements = await this.prisma.userAchievement.findMany({
      where: { userId },
      orderBy: { awardedAt: 'desc' },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { points: true },
    });

    return { achievements, points: user?.points || 0 };
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
}
