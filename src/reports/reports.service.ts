import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReportTarget } from '@prisma/client';

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  async createReport(reporterId: string, targetType: ReportTarget, targetId: string, reason: string) {
    return this.prisma.report.create({
      data: { reporterId, targetType, targetId, reason },
    });
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
