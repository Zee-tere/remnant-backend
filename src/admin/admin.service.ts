import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ListingStatus,
  Prisma,
  ReportStatus,
  TransactionStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TransactionsService } from '../transactions/transactions.service';
import { AdminReportAction, AdminReportActionDto, AdminUpdateUserDto } from './admin.dto';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private transactionsService: TransactionsService,
    private notificationsService: NotificationsService,
  ) {}

  async getDashboard() {
    const [totalUsers, activeListings, flaggedListings, openReports, bannedUsers, openTransactions, openDisputes] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.listing.count({ where: { status: 'ACTIVE' } }),
        this.prisma.listing.count({ where: { status: 'FLAGGED' } }),
        this.prisma.report.count({ where: { status: 'OPEN' } }),
        this.prisma.user.count({ where: { bannedAt: { not: null } } }),
        this.prisma.transaction.count({ where: { status: { in: ['INITIATED', 'FUNDED', 'SHIPPED'] } } }),
        this.prisma.transaction.count({ where: { status: 'DISPUTED' } }),
      ]);

    return {
      totalUsers,
      activeListings,
      flaggedListings,
      openReports,
      bannedUsers,
      openTransactions,
      openDisputes,
    };
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
    await this.prisma.listing.update({ where: { id }, data: { status: 'PAUSED' } });
    return { message: 'Listing removed from the public marketplace' };
  }

  async getAllTransactions(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          buyer: { select: { id: true, name: true } },
          seller: { select: { id: true, name: true } },
          listing: { select: { id: true, title: true } },
        },
      }),
      this.prisma.transaction.count(),
    ]);
    return { transactions, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async overrideTransactionStatus(id: string, status: TransactionStatus) {
    const allowedStatuses: TransactionStatus[] = [
      'INITIATED',
      'FUNDED',
      'SHIPPED',
      'RECEIVED',
      'COMPLETE',
      'DISPUTED',
      'REFUNDED',
    ];
    if (!allowedStatuses.includes(status)) {
      throw new BadRequestException(`Invalid transaction status: ${status}`);
    }
    return this.prisma.transaction.update({ where: { id }, data: { status } });
  }

  async refundTransaction(id: string, adminUserId: string) {
    return this.transactionsService.refundTransaction(id, adminUserId);
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
    const [listings, users] = await Promise.all([
      listingIds.length
        ? this.prisma.listing.findMany({
            where: { id: { in: listingIds } },
            select: { id: true, title: true, slug: true, status: true, userId: true },
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
          data: { status: dto.action === AdminReportAction.FLAG_LISTING ? 'FLAGGED' : 'PAUSED' },
        });
      }

      if (dto.action === AdminReportAction.BAN_USER) {
        if (report.targetType !== 'USER') {
          throw new BadRequestException('This action requires a user report');
        }
        await transaction.user.update({ where: { id: report.targetId }, data: { bannedAt: new Date() } });
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
