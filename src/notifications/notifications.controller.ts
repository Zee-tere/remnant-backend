import { Controller, Get, Patch, Param, Query, Req, UseGuards } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Request } from 'express';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  async getNotifications(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const user = req.user as { sub: string };
    return this.notificationsService.getNotifications(
      user.sub,
      Math.max(Number(page) || 1, 1),
      Math.min(Math.max(Number(limit) || 20, 1), 50),
    );
  }

  @Patch(':id/read')
  @UseGuards(JwtAuthGuard)
  async markAsRead(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as { sub: string };
    return this.notificationsService.markAsRead(id, user.sub);
  }

  @Patch('read-all')
  @UseGuards(JwtAuthGuard)
  async markAllAsRead(@Req() req: Request) {
    const user = req.user as { sub: string };
    return this.notificationsService.markAllAsRead(user.sub);
  }
}
