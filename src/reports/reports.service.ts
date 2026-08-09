import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReportTarget } from '@prisma/client';

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  async createReport(reporterId: string, targetType: ReportTarget, targetId: string, reason: string) {
    const targetExists = await this.findReportTarget(targetType, targetId, reporterId);
    if (!targetExists) throw new NotFoundException('Reported item was not found');

    return this.prisma.report.create({
      data: { reporterId, targetType, targetId, reason },
    });
  }

  private async findReportTarget(targetType: ReportTarget, targetId: string, reporterId: string) {
    if (targetType === 'LISTING') {
      return this.prisma.listing.findUnique({ where: { id: targetId }, select: { id: true } });
    }
    if (targetType === 'USER') {
      return this.prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
    }
    if (targetType === 'CONVERSATION') {
      const conversation = await this.prisma.conversation.findUnique({
        where: { id: targetId },
        select: { id: true, buyerId: true, sellerId: true },
      });
      if (conversation && ![conversation.buyerId, conversation.sellerId].includes(reporterId)) {
        throw new ForbiddenException('You can only report your own conversations.');
      }
      return conversation;
    }
    const message = await this.prisma.message.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        conversation: { select: { buyerId: true, sellerId: true } },
      },
    });
    if (message && ![message.conversation.buyerId, message.conversation.sellerId].includes(reporterId)) {
      throw new ForbiddenException('You can only report messages sent to your conversations.');
    }
    return message;
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
}
