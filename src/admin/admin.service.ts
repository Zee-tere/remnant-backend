import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ListingStatus, TransactionStatus, UserRole } from '@prisma/client';
import { TransactionsService } from '../transactions/transactions.service';
import { AdminUpdateUserDto } from './admin.dto';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private transactionsService: TransactionsService,
  ) {}

  async getDashboard() {
    const [totalUsers, activeListings, openTransactions, openDisputes] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.listing.count({ where: { status: 'ACTIVE' } }),
      this.prisma.transaction.count({ where: { status: { in: ['INITIATED', 'FUNDED', 'SHIPPED'] } } }),
      this.prisma.transaction.count({ where: { status: 'DISPUTED' } }),
    ]);

    return { totalUsers, activeListings, openTransactions, openDisputes };
  }

  async getUsers(page = 1, limit = 20, search?: string) {
    const skip = (page - 1) * limit;
    const where = search
      ? { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, { email: { contains: search, mode: 'insensitive' as const } }] }
      : {};

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, email: true, name: true, role: true, trustTier: true,
          points: true, bannedAt: true, createdAt: true, _count: { select: { listings: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { users, total, page, limit };
  }

  async updateUser(id: string, data: AdminUpdateUserDto) {
    return this.prisma.user.update({
      where: { id },
      data: {
        role: data.role as UserRole | undefined,
        bannedAt: data.bannedAt === null ? null : data.bannedAt ? new Date(data.bannedAt) : undefined,
      },
      select: { id: true, email: true, name: true, role: true, bannedAt: true },
    });
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
    return { transactions, total, page, limit };
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

  async getReports(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [reports, total] = await Promise.all([
      this.prisma.report.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { reporter: { select: { id: true, name: true } } },
      }),
      this.prisma.report.count(),
    ]);
    return { reports, total, page, limit };
  }

  async resolveReport(id: string, resolution: string) {
    return this.prisma.report.update({
      where: { id },
      data: { status: 'RESOLVED', resolution },
    });
  }
}
