import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Request } from 'express';
import { ReportTarget } from '@prisma/client';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  async createReport(
    @Body() body: { targetType: ReportTarget; targetId: string; reason: string },
    @Req() req: Request,
  ) {
    const user = req.user as { sub: string };
    return this.reportsService.createReport(user.sub, body.targetType, body.targetId, body.reason);
  }
}
