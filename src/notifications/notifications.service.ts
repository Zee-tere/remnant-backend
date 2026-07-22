import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationType } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../email/email.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private emailService: EmailService,
  ) {}

  async createNotification(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    link?: string,
  ) {
    const notification = await this.prisma.notification.create({
      data: { userId, type, title, body, link },
    });

    if (type === 'PAIR_MATCH') {
      await this.sendPairMatchEmail(userId, title, body, link).catch((error) => {
        const message = error instanceof Error ? error.message : 'Unknown email error';
        this.logger.warn(`Pair-match email skipped for user ${userId}: ${message}`);
      });
    }

    return notification;
  }

  async getNotifications(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [notifications, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.notification.count({ where: { userId } }),
      this.prisma.notification.count({ where: { userId, isRead: false } }),
    ]);

    return { notifications, total, unreadCount, page, limit };
  }

  async markAsRead(id: string, userId: string) {
    return this.prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true },
    });
  }

  async markAllAsRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
  }

  private async sendPairMatchEmail(userId: string, title: string, body: string, link?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user?.email || user.email.endsWith('@guest.remnant.local')) return;

    const frontendUrl = this.configService.get<string>('FRONTEND_URL', 'https://remnantmarket.co').replace(/\/$/, '');
    const matchUrl = `${frontendUrl}${link?.startsWith('/') ? link : '/'}`;
    await this.emailService.sendPairMatch(user.email, title, body, matchUrl);
  }
}
