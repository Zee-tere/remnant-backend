import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MessagesService {
  constructor(private prisma: PrismaService) {}

  async getConversations(userId: string) {
    return this.prisma.conversation.findMany({
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
  }

  async startConversation(buyerId: string, listingId: string) {
    const listing = await this.prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) throw new NotFoundException('Listing not found');
    if (listing.userId === buyerId) throw new ForbiddenException('Cannot message yourself');

    // Check if conversation already exists
    const existing = await this.prisma.conversation.findFirst({
      where: { listingId, buyerId },
    });
    if (existing) return existing;

    return this.prisma.conversation.create({
      data: {
        listingId,
        buyerId,
        sellerId: listing.userId,
      },
      include: {
        listing: { select: { id: true, title: true, slug: true, images: true } },
        buyer: { select: { id: true, name: true, avatarUrl: true } },
        seller: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
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

    return this.prisma.message.create({
      data: {
        conversationId,
        senderId,
        content,
        type,
      },
    });
  }

  async markAsRead(conversationId: string, userId: string) {
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
