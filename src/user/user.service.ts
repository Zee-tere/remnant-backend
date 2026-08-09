import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
  isPublicProfile: true,
  showStateOnProfile: true,
  deactivatedAt: true,
  deletionRequestedAt: true,
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
              isPublicProfile: true,
              showStateOnProfile: true,
            }),
        _count: {
          select: {
            listings: { where: { status: { not: 'DELETED' } } },
            reviewsReceived: true,
          },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    if (includePrivate) return user;
    if (!user.isPublicProfile) throw new NotFoundException('User not found');

    const { isPublicProfile: _isPublicProfile, showStateOnProfile, ...publicUser } = user;
    return {
      ...publicUser,
      city: showStateOnProfile ? publicUser.city : null,
    };
  }

  async updateUser(id: string, data: UpdateUserDto) {
    return this.prisma.user.update({
      where: { id },
      data,
      select: SAFE_USER_SELECT,
    });
  }

  async getDashboardSummary(userId: string) {
    const [listings, activeListings, unreadAlerts, listingMatches, pairAlertMatches, unreadMessageRows] = await Promise.all([
      this.prisma.listing.count({
        where: { userId, status: { not: 'DELETED' }, intentionTag: { not: 'WANTED' } },
      }),
      this.prisma.listing.count({ where: { userId, status: 'ACTIVE', intentionTag: { not: 'WANTED' } } }),
      this.prisma.notification.count({ where: { userId, type: 'PAIR_MATCH', isRead: false } }),
      this.prisma.match.count({
        where: {
          status: 'PENDING',
          OR: [{ listingA: { userId } }, { listingB: { userId } }],
        },
      }),
      this.prisma.pairAlertMatch.count({
        where: { status: 'PENDING', pairAlert: { userId } },
      }),
      this.prisma.$queryRaw<Array<{ count: number | bigint }>>(Prisma.sql`
        SELECT COUNT(*)::integer AS count
        FROM "Message" message
        JOIN "ConversationParticipant" participant
          ON participant."conversationId" = message."conversationId"
        WHERE participant."userId" = ${userId}
          AND message."senderId" <> ${userId}
          AND message.sequence > participant."lastReadSequence"
      `),
    ]);

    const unreadMessages = Number(unreadMessageRows[0]?.count ?? 0);

    return {
      listings,
      activeListings,
      unreadAlerts,
      pendingMatches: listingMatches + pairAlertMatches,
      unreadMessages,
    };
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
    await this.getUserById(userId);
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

  async requestDeletion(userId: string) {
    const requestedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.listing.updateMany({
        where: { userId, status: 'ACTIVE' },
        data: { status: 'PAUSED', version: { increment: 1 } },
      }),
      this.prisma.pairAlert.updateMany({
        where: { userId, status: 'ACTIVE' },
        data: { status: 'PAUSED', version: { increment: 1 } },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { deletionRequestedAt: requestedAt, deactivatedAt: requestedAt },
      }),
    ]);
    return {
      message: 'Your account is deactivated and its personal data is scheduled for anonymization after 30 days.',
      deletionRequestedAt: requestedAt,
    };
  }

  async exportUserData(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        ...SAFE_USER_SELECT,
        listings: true,
        pairAlerts: true,
        reviewsGiven: true,
        reviewsReceived: true,
        reports: true,
        notifications: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    const messages = await this.prisma.message.findMany({
      where: { senderId: userId },
      orderBy: { createdAt: 'asc' },
    });
    return { exportedAt: new Date().toISOString(), user, messages };
  }

  async purgeExpiredDeletionRequests(retentionDays = 30) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const users = await this.prisma.user.findMany({
      where: { deletionRequestedAt: { lte: cutoff } },
      select: { id: true },
      take: 100,
    });
    for (const user of users) {
      await this.prisma.$transaction([
        this.prisma.message.updateMany({ where: { senderId: user.id }, data: { content: '[deleted by sender]' } }),
        this.prisma.listing.updateMany({
          where: { userId: user.id },
          data: { status: 'DELETED', images: [], guestContact: Prisma.JsonNull, version: { increment: 1 } },
        }),
        this.prisma.upload.updateMany({
          where: { ownerId: user.id, status: { not: 'DELETED' } },
          data: { status: 'PENDING', listingId: null, attachedAt: null },
        }),
        this.prisma.user.update({
          where: { id: user.id },
          data: {
            email: `deleted-${user.id}@deleted.remnant.invalid`,
            name: 'Deleted user',
            avatarUrl: null,
            bio: null,
            city: null,
            googleId: null,
            passwordHash: null,
            isPublicProfile: false,
            showStateOnProfile: false,
            emailVerified: false,
            deletionRequestedAt: null,
          },
        }),
      ]);
    }
    return { purged: users.length };
  }
}
