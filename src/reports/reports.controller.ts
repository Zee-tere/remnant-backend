import { BadRequestException, Controller, Post, Body, Headers, Req, UseGuards } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { CreateReportDto } from './reports.dto';
import { GuestAccessService } from '../auth/guest-access.service';

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly guestAccessService: GuestAccessService,
  ) {}

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

  @Post('guest')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async createGuestReport(
    @Body() body: CreateReportDto,
    @Headers('x-guest-token') token?: string,
  ) {
    if (body.targetType !== 'CONVERSATION') {
      throw new BadRequestException('Guest reports must identify the conversation.');
    }
    let guest: { userId: string };
    try {
      guest = this.guestAccessService.verifyIdentityToken(token);
    } catch {
      guest = this.guestAccessService.verifyToken(token, 'conversation', body.targetId);
    }
    return this.reportsService.createReport(
      guest.userId,
      body.targetType,
      body.targetId,
      body.reason,
    );
  }
}
