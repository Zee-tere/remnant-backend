import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Message, MessageType, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { GuestAccessService } from '../auth/guest-access.service';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../utils/s3.service';
import {
  GetConversationsQueryDto,
  GetMessagesQueryDto,
  MarkConversationReadDto,
  StartGuestConversationDto,
} from './messages.dto';

type ConversationCursor = { activityAt: string; id: string };

@Injectable()
export class MessagesService {
  constructor(
    private prisma: PrismaService,
    private s3Service: S3Service,
    private guestAccessService: GuestAccessService,
  ) {}

  async startGuestConversation(dto: StartGuestConversationDto) {
    const listing = await this.prisma.listing.findFirst({
      where: { id: dto.listingId, status: 'ACTIVE' },
      select: { isGuestListing: true },
    });
    if (!listing) throw new NotFoundException('Active listing not found');
    if (listing.isGuestListing) {
      throw new BadRequestException('Use the seller contact shown on this listing');
    }

    const guest = await this.guestAccessService.getOrCreateGuestUser(
      dto.name,
      `guest-inquiry-${dto.clientRequestId}@guest.remnant.local`,
    );
    const conversation = await this.startConversation(guest.id, dto.listingId);
    const guestContact = this.normalizeGuestContact(dto.contactMethod, dto.contactValue);
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { guestContact },
    });
    const message = await this.createMessage(
      conversation.id,
      guest.id,
      dto.offer,
      'OFFER',
      dto.clientRequestId,
    );
    return {
      delivered: true,
      conversationId: conversation.id,
      messageId: message.id,
    };
  }

  async getGuestConversation(conversationId: string, token?: string) {
    const guest = this.resolveGuestActor(token, conversationId);
    const conversation = await this.getConversation(
      conversationId,
      guest.userId,
    );
    const messages = await this.getMessages(conversationId, guest.userId);
    return { conversation, messages };
  }

  async getGuestConversations(token?: string) {
    const guest = this.guestAccessService.verifyIdentityToken(token);
    return this.getConversations(guest.userId, { limit: 50 });
  }

  async createGuestMessage(
    conversationId: string,
    token: string | undefined,
    content: string,
    type: MessageType = 'TEXT',
    clientMessageId?: string,
  ) {
    const guest = this.resolveGuestActor(token, conversationId);
    return this.createMessage(
      conversationId,
      guest.userId,
      content,
      type,
      clientMessageId,
    );
  }

  async markGuestConversationRead(
    conversationId: string,
    token?: string,
    dto: MarkConversationReadDto = {},
  ) {
    const guest = this.resolveGuestActor(token, conversationId);
    return this.markAsRead(conversationId, guest.userId, dto);
  }

  async getConversations(userId: string, query: GetConversationsQueryDto = {}) {
    const paginated = query.limit !== undefined || query.cursor !== undefined;
    const limit = query.limit ?? 30;
    const cursor = query.cursor
      ? this.decodeConversationCursor(query.cursor)
      : null;

    const cursorFilter: Prisma.ConversationWhereInput | undefined = cursor
      ? {
          OR: [
            { activityAt: { lt: new Date(cursor.activityAt) } },
            {
              activityAt: new Date(cursor.activityAt),
              id: { lt: cursor.id },
            },
          ],
        }
      : undefined;

    const conversations = await this.prisma.conversation.findMany({
      where: {
        AND: [
          { OR: [{ buyerId: userId }, { sellerId: userId }] },
          ...(cursorFilter ? [cursorFilter] : []),
        ],
      },
      include: {
        listing: { select: { id: true, title: true, slug: true } },
        buyer: {
          select: { id: true, name: true, avatarUrl: true, email: true },
        },
        seller: { select: { id: true, name: true, avatarUrl: true } },
        participants: {
          select: {
            userId: true,
            lastReadSequence: true,
            lastReadAt: true,
          },
        },
        messages: {
          orderBy: { sequence: 'desc' },
          take: 1,
          select: {
            id: true,
            conversationId: true,
            clientMessageId: true,
            sequence: true,
            type: true,
            content: true,
            senderId: true,
            createdAt: true,
            readAt: true,
          },
        },
      },
      orderBy: [{ activityAt: 'desc' }, { id: 'desc' }],
      ...(paginated ? { take: limit + 1 } : {}),
    });

    const hasMore = paginated && conversations.length > limit;
    const page = hasMore ? conversations.slice(0, limit) : conversations;
    const rows = page.map((conversation) =>
      this.serializeConversation(conversation, userId),
    );

    if (!paginated) return rows;

    const last = page.at(-1);
    return {
      conversations: rows,
      hasMore,
      nextCursor:
        hasMore && last
          ? this.encodeConversationCursor({
              activityAt: last.activityAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  }

  async startConversation(buyerId: string, listingId: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      include: { user: { select: { email: true } } },
    });
    if (!listing || listing.status !== 'ACTIVE') {
      throw new NotFoundException('Active listing not found');
    }
    if (listing.isGuestListing) {
      throw new BadRequestException('Use the seller contact shown on this listing');
    }
    if (listing.userId === buyerId) {
      throw new ForbiddenException('Cannot message yourself');
    }

    const conversation = await this.prisma.$transaction(async (transaction) => {
      const row = await transaction.conversation.upsert({
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
          listing: {
            select: { id: true, title: true, slug: true, images: true },
          },
          buyer: {
            select: { id: true, name: true, avatarUrl: true, email: true },
          },
          seller: { select: { id: true, name: true, avatarUrl: true } },
        },
      });

      await transaction.conversationParticipant.createMany({
        data: [
          { conversationId: row.id, userId: row.buyerId },
          { conversationId: row.id, userId: row.sellerId },
        ],
        skipDuplicates: true,
      });
      return row;
    });

    return {
      ...conversation,
      buyer: {
        id: conversation.buyer.id,
        name: conversation.buyer.name,
        avatarUrl: conversation.buyer.avatarUrl,
        isGuest: conversation.buyer.email.endsWith('@guest.remnant.local'),
      },
      listing: {
        ...conversation.listing,
        images: await this.s3Service.getReadableUrls(
          conversation.listing.images,
        ),
      },
    };
  }

  async getMessages(
    conversationId: string,
    userId: string,
    query: GetMessagesQueryDto = {},
  ) {
    if (
      query.afterSequence !== undefined &&
      query.beforeSequence !== undefined
    ) {
      throw new BadRequestException(
        'Use either afterSequence or beforeSequence, not both',
      );
    }

    const conversation = await this.getConversationMembership(
      conversationId,
      userId,
    );
    const paginated =
      query.limit !== undefined ||
      query.afterSequence !== undefined ||
      query.beforeSequence !== undefined;

    if (!paginated) {
      const messages = await this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { sequence: 'asc' },
      });
      return messages.map((message) =>
        this.serializeMessage(message, conversation),
      );
    }

    const limit = query.limit ?? 50;
    const isBefore = query.beforeSequence !== undefined;
    const messages = await this.prisma.message.findMany({
      where: {
        conversationId,
        ...(query.afterSequence !== undefined
          ? { sequence: { gt: query.afterSequence } }
          : query.beforeSequence !== undefined
            ? { sequence: { lt: query.beforeSequence } }
            : {}),
      },
      orderBy: {
        sequence:
          isBefore || query.afterSequence === undefined ? 'desc' : 'asc',
      },
      take: limit + 1,
    });
    const hasMore = messages.length > limit;
    const selected = hasMore ? messages.slice(0, limit) : messages;
    if (isBefore || query.afterSequence === undefined) selected.reverse();
    const rows = selected.map((message) =>
      this.serializeMessage(message, conversation),
    );

    return {
      messages: rows,
      hasMore,
      previousCursor: rows[0]?.sequence ?? null,
      nextCursor: rows.at(-1)?.sequence ?? query.afterSequence ?? null,
    };
  }

  private async getConversation(conversationId: string, userId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        listing: {
          select: { id: true, title: true, slug: true, images: true },
        },
        buyer: { select: { id: true, name: true, avatarUrl: true } },
        seller: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    this.assertMembership(conversation, userId);
    return {
      ...conversation,
      listing: {
        ...conversation.listing,
        images: await this.s3Service.getReadableUrls(
          conversation.listing.images,
        ),
      },
    };
  }

  async createMessage(
    conversationId: string,
    senderId: string,
    content: string,
    type: MessageType = 'TEXT',
    requestedClientMessageId?: string,
  ) {
    const clientMessageId = requestedClientMessageId ?? randomUUID();

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const conversation = await transaction.conversation.findUnique({
          where: { id: conversationId },
        });
        if (!conversation) {
          throw new NotFoundException('Conversation not found');
        }
        this.assertMembership(conversation, senderId);

        const existing = await transaction.message.findUnique({
          where: {
            conversationId_senderId_clientMessageId: {
              conversationId,
              senderId,
              clientMessageId,
            },
          },
        });
        if (existing) return existing;

        const sequencedConversation = await transaction.conversation.update({
          where: { id: conversationId },
          data: { nextMessageSequence: { increment: 1 } },
          select: {
            buyerId: true,
            sellerId: true,
            nextMessageSequence: true,
          },
        });
        const recipientId =
          sequencedConversation.buyerId === senderId
            ? sequencedConversation.sellerId
            : sequencedConversation.buyerId;

        const message = await transaction.message.create({
          data: {
            conversationId,
            senderId,
            clientMessageId,
            sequence: sequencedConversation.nextMessageSequence,
            content,
            type,
          },
        });

        const outboxEventId = randomUUID();
        await transaction.outboxEvent.create({
          data: {
            id: outboxEventId,
            eventType: 'MESSAGE_NOTIFICATION_REQUESTED',
            aggregateType: 'Message',
            aggregateId: message.id,
            messageId: message.id,
            clientMessageId,
            conversationId,
            recipientId,
            payload: {
              eventId: outboxEventId,
              messageId: message.id,
              clientMessageId,
              conversationId,
              recipientId,
              sequence: message.sequence,
              occurredAt: message.createdAt.toISOString(),
            },
          },
        });

        return message;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.message.findUnique({
          where: {
            conversationId_senderId_clientMessageId: {
              conversationId,
              senderId,
              clientMessageId,
            },
          },
        });
        if (existing) return existing;
      }
      throw error;
    }
  }

  async markAsRead(
    conversationId: string,
    userId: string,
    dto: MarkConversationReadDto = {},
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    this.assertMembership(conversation, userId);

    let targetSequence = dto.lastReadSequence;
    if (dto.lastReadMessageId) {
      const message = await this.prisma.message.findUnique({
        where: { id: dto.lastReadMessageId },
        select: { conversationId: true, sequence: true },
      });
      if (!message || message.conversationId !== conversationId) {
        throw new BadRequestException(
          'lastReadMessageId is not part of this conversation',
        );
      }
      targetSequence = Math.max(targetSequence ?? 0, message.sequence);
    }

    if (targetSequence === undefined) {
      const latest = await this.prisma.message.findFirst({
        where: { conversationId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      targetSequence = latest?.sequence ?? 0;
    }
    targetSequence = Math.min(
      Math.max(0, targetSequence),
      conversation.nextMessageSequence,
    );

    await this.prisma.conversationParticipant.upsert({
      where: { conversationId_userId: { conversationId, userId } },
      create: { conversationId, userId },
      update: {},
    });

    const rows = await this.prisma.$queryRaw<
      Array<{ lastReadSequence: number; lastReadAt: Date | null }>
    >(Prisma.sql`
      UPDATE "ConversationParticipant"
      SET
        "lastReadSequence" = GREATEST("lastReadSequence", ${targetSequence}),
        "lastReadAt" = CASE
          WHEN "lastReadSequence" < ${targetSequence} THEN CURRENT_TIMESTAMP
          ELSE "lastReadAt"
        END
      WHERE "conversationId" = ${conversationId}
        AND "userId" = ${userId}
      RETURNING "lastReadSequence", "lastReadAt"
    `);

    return {
      message: 'Messages marked as read',
      lastReadSequence: rows[0]?.lastReadSequence ?? targetSequence,
      lastReadAt: rows[0]?.lastReadAt ?? null,
    };
  }

  private async getConversationMembership(
    conversationId: string,
    userId: string,
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        participants: {
          select: {
            userId: true,
            lastReadSequence: true,
            lastReadAt: true,
          },
        },
      },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    this.assertMembership(conversation, userId);
    return conversation;
  }

  private assertMembership(
    conversation: { buyerId: string; sellerId: string },
    userId: string,
  ) {
    if (conversation.buyerId !== userId && conversation.sellerId !== userId) {
      throw new ForbiddenException('Not a member of this conversation');
    }
  }

  private resolveGuestActor(token: string | undefined, conversationId: string) {
    try {
      return this.guestAccessService.verifyToken(token, 'conversation', conversationId);
    } catch {
      return this.guestAccessService.verifyIdentityToken(token);
    }
  }

  private serializeMessage(
    message: Message,
    conversation: {
      buyerId: string;
      sellerId: string;
      participants: Array<{
        userId: string;
        lastReadSequence: number;
        lastReadAt: Date | null;
      }>;
    },
  ) {
    const recipientId =
      message.senderId === conversation.buyerId
        ? conversation.sellerId
        : conversation.buyerId;
    const recipient = conversation.participants.find(
      (participant) => participant.userId === recipientId,
    );
    return {
      ...message,
      readAt:
        message.readAt ??
        (recipient && message.sequence <= recipient.lastReadSequence
          ? recipient.lastReadAt
          : null),
    };
  }

  private serializeConversation<
    T extends {
      buyerId: string;
      sellerId: string;
      buyer: {
        id: string;
        name: string;
        avatarUrl: string | null;
        email: string;
      };
      participants: Array<{
        userId: string;
        lastReadSequence: number;
        lastReadAt: Date | null;
      }>;
      messages: Message[];
    },
  >(conversation: T, userId: string) {
    const ownReadState = conversation.participants.find(
      (participant) => participant.userId === userId,
    );
    const otherReadState = conversation.participants.find(
      (participant) => participant.userId !== userId,
    );
    const messages = conversation.messages;
    const rest = this.withoutMessagingRelations(conversation);
    return {
      ...rest,
      buyer: {
        id: conversation.buyer.id,
        name: conversation.buyer.name,
        avatarUrl: conversation.buyer.avatarUrl,
        isGuest: conversation.buyer.email.endsWith('@guest.remnant.local'),
      },
      messages: messages.map((message) =>
        this.serializeMessage(message, conversation),
      ),
      readState: {
        lastReadSequence: ownReadState?.lastReadSequence ?? 0,
        otherLastReadSequence: otherReadState?.lastReadSequence ?? 0,
      },
    };
  }

  private normalizeGuestContact(method: 'WHATSAPP' | 'EMAIL' | 'TELEGRAM', rawValue: string) {
    const value = rawValue.trim();
    if (method === 'EMAIL') {
      const email = value.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
        throw new BadRequestException('Enter a valid email address');
      }
      return { method, value: email };
    }
    if (method === 'WHATSAPP') {
      let phone = value.replace(/[^\d+]/g, '');
      if (phone.startsWith('+')) phone = phone.slice(1);
      if (phone.startsWith('0')) phone = `234${phone.slice(1)}`;
      if (!/^\d{10,15}$/.test(phone)) {
        throw new BadRequestException('Enter a valid WhatsApp number with country code');
      }
      return { method, value: phone };
    }
    const username = value
      .replace(/^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\//i, '')
      .replace(/^@/, '')
      .replace(/\/$/, '');
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
      throw new BadRequestException('Enter a valid Telegram username');
    }
    return { method, value: `@${username}` };
  }

  private encodeConversationCursor(cursor: ConversationCursor) {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private withoutMessagingRelations<
    T extends { participants: unknown; messages: unknown },
  >(conversation: T): Omit<T, 'participants' | 'messages'> {
    const copy: Partial<T> = { ...conversation };
    delete copy.participants;
    delete copy.messages;
    return copy as Omit<T, 'participants' | 'messages'>;
  }

  private decodeConversationCursor(value: string): ConversationCursor {
    try {
      const parsed = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as ConversationCursor;
      if (
        !parsed.id ||
        !parsed.activityAt ||
        Number.isNaN(new Date(parsed.activityAt).getTime())
      ) {
        throw new Error('Invalid cursor');
      }
      return parsed;
    } catch {
      throw new BadRequestException('Invalid conversation cursor');
    }
  }
}
