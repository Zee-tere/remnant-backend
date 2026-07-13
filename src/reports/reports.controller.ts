import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { CreateReportDto } from './reports.dto';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async createReport(
    @Body() body: CreateReportDto,
    @Req() req: Request,
  ) {
    const user = req.user as { sub: string };
    return this.reportsService.createReport(user.sub, body.targetType, body.targetId, body.reason);
  }
}
