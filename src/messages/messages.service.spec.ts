import { MessagesService } from './messages.service';

describe('MessagesService', () => {
  const conversation = {
    id: 'conversation-1',
    buyerId: 'buyer-1',
    sellerId: 'seller-1',
    nextMessageSequence: 4,
    participants: [
      { userId: 'buyer-1', lastReadSequence: 2, lastReadAt: new Date() },
      { userId: 'seller-1', lastReadSequence: 1, lastReadAt: new Date() },
    ],
  };

  function createService(prismaOverrides: Record<string, unknown> = {}) {
    const prisma = {
      conversation: { findUnique: jest.fn() },
      conversationParticipant: { upsert: jest.fn() },
      message: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      $queryRaw: jest.fn(),
      $transaction: jest.fn(),
      ...prismaOverrides,
    } as any;
    const service = new MessagesService(
      prisma,
      { getReadableUrls: jest.fn() } as any,
      {} as any,
    );
    return { service, prisma };
  }

  it('returns an ordered cursor page after a sequence', async () => {
    const { service, prisma } = createService();
    prisma.conversation.findUnique.mockResolvedValue(conversation);
    prisma.message.findMany.mockResolvedValue([
      {
        id: 'message-3',
        conversationId: conversation.id,
        senderId: 'seller-1',
        clientMessageId: 'client-3',
        sequence: 3,
        type: 'TEXT',
        content: 'Three',
        readAt: null,
        createdAt: new Date(),
      },
      {
        id: 'message-4',
        conversationId: conversation.id,
        senderId: 'buyer-1',
        clientMessageId: 'client-4',
        sequence: 4,
        type: 'TEXT',
        content: 'Four',
        readAt: null,
        createdAt: new Date(),
      },
    ]);

    const result = await service.getMessages(conversation.id, 'buyer-1', {
      afterSequence: 2,
      limit: 2,
    });

    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationId: conversation.id, sequence: { gt: 2 } },
        orderBy: { sequence: 'asc' },
        take: 3,
      }),
    );
    expect(result).toMatchObject({
      hasMore: false,
      previousCursor: 3,
      nextCursor: 4,
    });
  });

  it('advances a participant read cursor without touching message rows', async () => {
    const { service, prisma } = createService();
    prisma.conversation.findUnique.mockResolvedValue(conversation);
    prisma.conversationParticipant.upsert.mockResolvedValue({});
    prisma.$queryRaw.mockResolvedValue([
      { lastReadSequence: 4, lastReadAt: new Date('2026-08-04T12:00:00Z') },
    ]);

    const result = await service.markAsRead(conversation.id, 'buyer-1', {
      lastReadSequence: 4,
    });

    expect(prisma.conversationParticipant.upsert).toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result.lastReadSequence).toBe(4);
    expect((prisma as any).message.updateMany).toBeUndefined();
  });

  it('writes the message, notification and outbox event in one transaction', async () => {
    const transaction = {
      conversation: {
        findUnique: jest.fn().mockResolvedValue(conversation),
        update: jest
          .fn()
          .mockResolvedValueOnce({
            buyerId: 'buyer-1',
            sellerId: 'seller-1',
            nextMessageSequence: 5,
          }),
      },
      message: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'message-5',
          conversationId: conversation.id,
          senderId: 'buyer-1',
          clientMessageId: '6f703f45-0fa4-4aa1-9b44-cc8073ea8f5e',
          sequence: 5,
          content: 'Hello',
          type: 'TEXT',
          readAt: null,
          createdAt: new Date('2026-08-04T12:00:00Z'),
        }),
      },
      notification: {
        create: jest.fn().mockResolvedValue({ id: 'notification-1' }),
      },
      outboxEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const { service, prisma } = createService();
    prisma.$transaction.mockImplementation(
      (callback: (tx: unknown) => unknown) => callback(transaction),
    );

    const message = await service.createMessage(
      conversation.id,
      'buyer-1',
      'Hello',
      'TEXT',
      '6f703f45-0fa4-4aa1-9b44-cc8073ea8f5e',
    );

    expect(message.sequence).toBe(5);
    expect(transaction.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sequence: 5,
        clientMessageId: message.clientMessageId,
      }),
    });
    expect(transaction.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'seller-1' }),
    });
    const outboxData = transaction.outboxEvent.create.mock.calls[0][0].data;
    expect(outboxData.id).toBe(outboxData.payload.eventId);
    expect(outboxData.messageId).toBe('message-5');
    expect(outboxData.clientMessageId).toBe(message.clientMessageId);
  });

  it('returns the existing message for a repeated client message ID', async () => {
    const existing = {
      id: 'message-existing',
      conversationId: conversation.id,
      senderId: 'buyer-1',
      clientMessageId: '6f703f45-0fa4-4aa1-9b44-cc8073ea8f5e',
      sequence: 4,
    };
    const transaction = {
      conversation: {
        findUnique: jest.fn().mockResolvedValue(conversation),
        update: jest.fn(),
      },
      message: {
        findUnique: jest.fn().mockResolvedValue(existing),
        create: jest.fn(),
      },
      notification: { create: jest.fn() },
      outboxEvent: { create: jest.fn() },
    };
    const { service, prisma } = createService();
    prisma.$transaction.mockImplementation(
      (callback: (tx: unknown) => unknown) => callback(transaction),
    );

    const result = await service.createMessage(
      conversation.id,
      'buyer-1',
      'Hello again',
      'TEXT',
      existing.clientMessageId,
    );

    expect(result).toBe(existing);
    expect(transaction.conversation.update).not.toHaveBeenCalled();
    expect(transaction.message.create).not.toHaveBeenCalled();
    expect(transaction.outboxEvent.create).not.toHaveBeenCalled();
  });
});
