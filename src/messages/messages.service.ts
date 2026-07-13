import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { S3Service } from '../utils/s3.service';

@Injectable()
export class MessagesService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
    private s3Service: S3Service,
  ) {}

  async getConversations(userId: string) {
    const conversations = await this.prisma.conversation.findMany({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
      },
      include: {
        listing: { select: { id: true, title: true, slug: true, images: true } },
        buyer: { select: { id: true, name: true, avatarUrl: true } },
        seller: { select: { id: true, name: true, avatarUrl: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, content: true, senderId: true, createdAt: true, readAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(
      conversations.map(async (conversation) => ({
        ...conversation,
        listing: {
          ...conversation.listing,
          images: await this.s3Service.getReadableUrls(conversation.listing.images),
        },
      })),
    );
  }

  async startConversation(buyerId: string, listingId: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      include: { user: { select: { email: true } } },
    });
    if (!listing || listing.status !== 'ACTIVE') throw new NotFoundException('Active listing not found');
    if (listing.user.email.endsWith('@guest.remnant.local')) {
      throw new ForbiddenException('This guest seller has not joined Remnant yet, so messaging is not available.');
    }
    if (listing.userId === buyerId) throw new ForbiddenException('Cannot message yourself');

    const conversation = await this.prisma.conversation.upsert({
      where: {
        listingId_buyerId_sellerId: {
          listingId,
          buyerId,
          sellerId: listing.userId,
        },
      },
      create: { listingId, buyerId, sellerId: listing.userId },
      update: {},
      include: {
        listing: { select: { id: true, title: true, slug: true, images: true } },
        buyer: { select: { id: true, name: true, avatarUrl: true } },
        seller: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
    return {
      ...conversation,
      listing: {
        ...conversation.listing,
        images: await this.s3Service.getReadableUrls(conversation.listing.images),
      },
    };
  }

  async getMessages(conversationId: string, userId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.buyerId !== userId && conversation.sellerId !== userId) {
      throw new ForbiddenException('Not a member of this conversation');
    }

    return this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createMessage(conversationId: string, senderId: string, content: string, type: 'TEXT' | 'IMAGE' | 'OFFER' | 'SYSTEM' = 'TEXT') {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.buyerId !== senderId && conversation.sellerId !== senderId) {
      throw new ForbiddenException('Not a member of this conversation');
    }

    const message = await this.prisma.message.create({
      data: {
        conversationId,
        senderId,
        content,
        type,
      },
    });

    const recipientId = conversation.buyerId === senderId ? conversation.sellerId : conversation.buyerId;
    await this.notificationsService.createNotification(
      recipientId,
      'MESSAGE_RECEIVED',
      'New message',
      content.length > 90 ? `${content.slice(0, 87)}...` : content,
      '/user/dashboard?section=messages',
    );
    return message;
  }

  async markAsRead(conversationId: string, userId: string) {
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.buyerId !== userId && conversation.sellerId !== userId) {
      throw new ForbiddenException('Not a member of this conversation');
    }
    await this.prisma.message.updateMany({
      where: {
        conversationId,
        senderId: { not: userId },
        readAt: null,
      },
      data: { readAt: new Date() },
    });
    return { message: 'Messages marked as read' };
  }
}
