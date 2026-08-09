import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ListingStatus,
  Prisma,
  ReportStatus,
  SupportRequestStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AdminReportAction, AdminReportActionDto, AdminUpdateUserDto, ResolveSupportRequestDto } from './admin.dto';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) {}

  async getDashboard() {
    const [totalUsers, activeListings, flaggedListings, openReports, bannedUsers] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.listing.count({ where: { status: 'ACTIVE' } }),
        this.prisma.listing.count({ where: { status: 'FLAGGED' } }),
        this.prisma.report.count({ where: { status: 'OPEN' } }),
        this.prisma.user.count({ where: { bannedAt: { not: null } } }),
      ]);

    return {
      totalUsers,
      activeListings,
      flaggedListings,
      openReports,
      bannedUsers,
    };
  }

  async getSupportRequests(page = 1, limit = 20, status?: string) {
    const parsedStatus = status && Object.values(SupportRequestStatus).includes(status as SupportRequestStatus)
      ? status as SupportRequestStatus
      : undefined;
    const where = parsedStatus ? { status: parsedStatus } : {};
    const [requests, total] = await Promise.all([
      this.prisma.supportRequest.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.supportRequest.count({ where }),
    ]);
    return { requests, total, page, limit };
  }

  async updateSupportRequest(id: string, dto: ResolveSupportRequestDto) {
    const request = await this.prisma.supportRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Support request not found');
    return this.prisma.supportRequest.update({
      where: { id },
      data: { status: dto.status, resolution: dto.resolution },
    });
  }

  async getUsers(page = 1, limit = 20, search?: string) {
    const skip = (page - 1) * limit;
    const where: Prisma.UserWhereInput = search
      ? {
          AND: [
            { email: { not: { endsWith: '@guest.remnant.local' } } },
            {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
              ],
            },
          ],
        }
      : { email: { not: { endsWith: '@guest.remnant.local' } } };

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          trustTier: true,
          points: true,
          bannedAt: true,
          createdAt: true,
          _count: { select: { listings: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { users, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async updateUser(id: string, data: AdminUpdateUserDto, adminUserId: string) {
    if (id === adminUserId && ((data.role && data.role !== 'ADMIN') || data.bannedAt)) {
      throw new ForbiddenException('You cannot demote or suspend your own administrator account');
    }

    return this.prisma.user.update({
      where: { id },
      data: {
        role: data.role as UserRole | undefined,
        bannedAt: data.bannedAt === null ? null : data.bannedAt ? new Date(data.bannedAt) : undefined,
      },
      select: { id: true, email: true, name: true, role: true, bannedAt: true },
    });
  }

  async messageUser(id: string, message: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true, email: true } });
    if (!user) throw new NotFoundException('Seller not found');
    if (user.email.endsWith('@guest.remnant.local')) {
      throw new BadRequestException('Use the guest seller contact details instead');
    }

    await this.notificationsService.createNotification(
      user.id,
      'SYSTEM',
      'Message from Remnant',
      message.trim(),
      '/user/dashboard?section=alerts',
    );
    return { message: 'Seller notified' };
  }

  async getListings(page = 1, limit = 20, search?: string, status?: string) {
    const skip = (page - 1) * limit;
    const listingStatus = this.parseListingStatus(status);
    const where: Prisma.ListingWhereInput = {
      ...(listingStatus ? { status: listingStatus } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { description: { contains: search, mode: 'insensitive' } },
              { user: { name: { contains: search, mode: 'insensitive' } } },
              { user: { email: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [listings, total] = await Promise.all([
      this.prisma.listing.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          slug: true,
          status: true,
          intentionTag: true,
          category: true,
          city: true,
          images: true,
          viewCount: true,
          isGuestListing: true,
          guestContact: true,
          createdAt: true,
          updatedAt: true,
          user: { select: { id: true, name: true, email: true, bannedAt: true } },
        },
      }),
      this.prisma.listing.count({ where }),
    ]);

    return { listings, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getFlaggedListings() {
    return this.prisma.listing.findMany({
      where: { status: 'FLAGGED' },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async updateListingStatus(id: string, status: ListingStatus) {
    return this.prisma.listing.update({ where: { id }, data: { status } });
  }

  async removeListing(id: string) {
    const listing = await this.prisma.listing.findUnique({ where: { id }, select: { id: true } });
    if (!listing) throw new NotFoundException('Listing not found');
    await this.prisma.listing.update({ where: { id }, data: { status: 'DELETED' } });
    return { message: 'Listing removed from the public marketplace' };
  }

  async getReports(page = 1, limit = 20, status?: string) {
    const skip = (page - 1) * limit;
    const reportStatus = this.parseReportStatus(status);
    const where: Prisma.ReportWhereInput = reportStatus ? { status: reportStatus } : {};
    const [reports, total] = await Promise.all([
      this.prisma.report.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { reporter: { select: { id: true, name: true, email: true } } },
      }),
      this.prisma.report.count({ where }),
    ]);

    const listingIds = reports.filter((report) => report.targetType === 'LISTING').map((report) => report.targetId);
    const userIds = reports.filter((report) => report.targetType === 'USER').map((report) => report.targetId);
    const conversationIds = reports.filter((report) => report.targetType === 'CONVERSATION').map((report) => report.targetId);
    const messageIds = reports.filter((report) => report.targetType === 'MESSAGE').map((report) => report.targetId);
    const [listings, users, conversations, messages] = await Promise.all([
      listingIds.length
        ? this.prisma.listing.findMany({
            where: { id: { in: listingIds } },
            select: { id: true, title: true, slug: true, status: true, userId: true },
          })
        : [],
      conversationIds.length
        ? this.prisma.conversation.findMany({
            where: { id: { in: conversationIds } },
            select: { id: true, listing: { select: { title: true, slug: true } }, buyerId: true, sellerId: true },
          })
        : [],
      messageIds.length
        ? this.prisma.message.findMany({
            where: { id: { in: messageIds } },
            select: { id: true, content: true, senderId: true, conversationId: true, createdAt: true },
          })
        : [],
      userIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, email: true, bannedAt: true },
          })
        : [],
    ]);
    const targets = new Map<string, unknown>([
      ...listings.map((listing) => [`LISTING:${listing.id}`, listing] as const),
      ...users.map((user) => [`USER:${user.id}`, user] as const),
      ...conversations.map((conversation) => [`CONVERSATION:${conversation.id}`, {
        ...conversation,
        title: `Conversation about ${conversation.listing.title}`,
        slug: conversation.listing.slug,
      }] as const),
      ...messages.map((message) => [`MESSAGE:${message.id}`, { ...message, title: 'Reported message' }] as const),
    ]);

    return {
      reports: reports.map((report) => ({
        ...report,
        target: targets.get(`${report.targetType}:${report.targetId}`) ?? null,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async actOnReport(id: string, dto: AdminReportActionDto) {
    const report = await this.prisma.report.findUnique({ where: { id } });
    if (!report) throw new NotFoundException('Report not found');

    const resolution = dto.resolution?.trim() || this.defaultResolution(dto.action);
    await this.prisma.$transaction(async (transaction) => {
      if (dto.action === AdminReportAction.FLAG_LISTING || dto.action === AdminReportAction.REMOVE_LISTING) {
        if (report.targetType !== 'LISTING') {
          throw new BadRequestException('This action requires a listing report');
        }
        await transaction.listing.update({
          where: { id: report.targetId },
          data: { status: dto.action === AdminReportAction.FLAG_LISTING ? 'FLAGGED' : 'DELETED' },
        });
      }

      if (dto.action === AdminReportAction.BAN_USER) {
        let reportedUserId: string | null = report.targetType === 'USER' ? report.targetId : null;
        if (report.targetType === 'CONVERSATION') {
          const conversation = await transaction.conversation.findUnique({
            where: { id: report.targetId },
            select: { buyerId: true, sellerId: true },
          });
          reportedUserId = conversation
            ? [conversation.buyerId, conversation.sellerId].find((id) => id !== report.reporterId) ?? null
            : null;
        }
        if (report.targetType === 'MESSAGE') {
          const message = await transaction.message.findUnique({
            where: { id: report.targetId },
            select: { senderId: true },
          });
          reportedUserId = message?.senderId !== report.reporterId ? message?.senderId ?? null : null;
        }
        if (!reportedUserId) throw new BadRequestException('No reported user could be identified');
        await transaction.user.update({ where: { id: reportedUserId }, data: { bannedAt: new Date() } });
      }

      await transaction.report.update({
        where: { id },
        data: { status: 'RESOLVED', resolution },
      });
    });

    return { message: resolution };
  }

  async resolveReport(id: string, resolution: string) {
    return this.prisma.report.update({
      where: { id },
      data: { status: 'RESOLVED', resolution },
    });
  }

  private parseListingStatus(status?: string) {
    if (!status) return undefined;
    const normalized = status.toUpperCase() as ListingStatus;
    if (!Object.values(ListingStatus).includes(normalized)) {
      throw new BadRequestException('Unknown listing status');
    }
    return normalized;
  }

  private parseReportStatus(status?: string) {
    if (!status) return undefined;
    const normalized = status.toUpperCase() as ReportStatus;
    if (!Object.values(ReportStatus).includes(normalized)) {
      throw new BadRequestException('Unknown report status');
    }
    return normalized;
  }

  private defaultResolution(action: AdminReportAction) {
    const labels: Record<AdminReportAction, string> = {
      [AdminReportAction.DISMISS]: 'Report reviewed and dismissed',
      [AdminReportAction.FLAG_LISTING]: 'Listing flagged for moderation',
      [AdminReportAction.REMOVE_LISTING]: 'Listing removed from the marketplace',
      [AdminReportAction.BAN_USER]: 'User account suspended',
    };
    return labels[action];
  }
}
