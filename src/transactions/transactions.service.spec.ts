import { TransactionsService } from './transactions.service';

describe('TransactionsService', () => {
  const config = { get: jest.fn((key: string, fallback: string) => fallback) };
  const escrowEnabledConfig = {
    get: jest.fn((key: string, fallback: string) => (key === 'ESCROW_ENABLED' ? 'true' : fallback)),
  };
  const escrow = {
    createEscrowTransaction: jest.fn(),
    markShipped: jest.fn().mockResolvedValue({ status: 'ship' }),
    markReceived: jest.fn(),
    acceptItems: jest.fn(),
    cancelTransaction: jest.fn(),
    normalizeWebhook: jest.fn(),
    getEscrowTransaction: jest.fn(),
    isPaymentApprovedEvent: jest.fn(),
    isShippedEvent: jest.fn(),
    isReceivedEvent: jest.fn(),
    isAcceptedOrCompleteEvent: jest.fn(),
    isRefundedOrCancelledEvent: jest.fn(),
  };
  const notifications = { createNotification: jest.fn().mockResolvedValue({}) };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('blocks shipment until escrow is funded', async () => {
    const prisma = {
      transaction: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tx-1',
          sellerId: 'seller-1',
          buyerId: 'buyer-1',
          status: 'INITIATED',
          seller: { email: 'seller@example.com' },
        }),
      },
    };

    const service = new TransactionsService(prisma as any, escrowEnabledConfig as any, escrow as any, notifications as any);

    await expect(service.markShipped('tx-1', 'seller-1')).rejects.toThrow('Escrow must be funded');
  });

  it('marks a funded transaction as shipped and notifies buyer', async () => {
    const prisma = {
      transaction: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tx-1',
          sellerId: 'seller-1',
          buyerId: 'buyer-1',
          status: 'FUNDED',
          escrowTransactionId: 'escrow-1',
          seller: { email: 'seller@example.com' },
        }),
        update: jest.fn().mockResolvedValue({ id: 'tx-1', status: 'SHIPPED' }),
      },
    };

    const service = new TransactionsService(prisma as any, escrowEnabledConfig as any, escrow as any, notifications as any);
    const result = await service.markShipped('tx-1', 'seller-1', 'TRACK-123');

    expect(result.status).toBe('SHIPPED');
    expect(escrow.markShipped).toHaveBeenCalledWith('escrow-1', 'seller@example.com', 'TRACK-123');
    expect(prisma.transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SHIPPED',
          trackingInfo: 'TRACK-123',
          shippedAt: expect.any(Date),
        }),
      }),
    );
    expect(notifications.createNotification).toHaveBeenCalledWith(
      'buyer-1',
      'TRANSACTION_UPDATE',
      'Item marked as shipped',
      expect.any(String),
      '/transactions/tx-1',
    );
  });
});
