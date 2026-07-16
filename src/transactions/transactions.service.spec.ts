import { TransactionsService } from './transactions.service';
import { Prisma } from '@prisma/client';

describe('TransactionsService', () => {
  const config = { get: jest.fn((key: string, fallback: string) => fallback) };
  const escrowEnabledConfig = {
    get: jest.fn((key: string, fallback: string) =>
      key === 'ESCROW_ENABLED' ? 'true' : fallback,
    ),
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
  const paystack = {
    isEnabled: jest.fn().mockReturnValue(false),
    initializeTransaction: jest.fn(),
    verifyTransaction: jest.fn(),
  };
  const guestAccess = {
    isConfigured: jest.fn().mockReturnValue(false),
    verifyToken: jest.fn(),
    getOrCreateGuestUser: jest.fn(),
    issueToken: jest.fn(),
  };

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

    const service = new TransactionsService(
      prisma as any,
      escrowEnabledConfig as any,
      escrow as any,
      notifications as any,
      paystack as any,
      guestAccess as any,
    );

    await expect(service.markShipped('tx-1', 'seller-1')).rejects.toThrow(
      'Payment must be confirmed',
    );
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

    const service = new TransactionsService(
      prisma as any,
      escrowEnabledConfig as any,
      escrow as any,
      notifications as any,
      paystack as any,
      guestAccess as any,
    );
    const result = await service.markShipped('tx-1', 'seller-1', 'TRACK-123');

    expect(result.status).toBe('SHIPPED');
    expect(escrow.markShipped).toHaveBeenCalledWith(
      'escrow-1',
      'seller@example.com',
      'TRACK-123',
    );
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

  it('does not fund an order when Paystack returns a different amount', async () => {
    const transaction = {
      id: 'tx-1',
      amount: new Prisma.Decimal(5000),
      status: 'INITIATED',
      escrowTransactionId: 'remnant-tx-1',
      escrowCheckoutUrl: 'https://checkout.paystack.com/example',
      escrowProviderStatus: 'paystack:initialized',
      listing: { id: 'listing-1', title: 'Chair', slug: 'chair', images: [] },
      buyer: { id: 'buyer-1', name: 'Buyer', avatarUrl: null },
      seller: { id: 'seller-1', name: 'Seller', avatarUrl: null },
    };
    const prisma = {
      transaction: {
        findFirst: jest.fn().mockResolvedValue(transaction),
        update: jest.fn().mockResolvedValue(transaction),
      },
    };
    paystack.verifyTransaction.mockResolvedValue({
      status: 'success',
      reference: 'remnant-tx-1',
      amount: 499900,
      currency: 'NGN',
    });
    const service = new TransactionsService(
      prisma as any,
      config as any,
      escrow as any,
      notifications as any,
      paystack as any,
      guestAccess as any,
    );

    await expect(
      service.verifyPaystackTransaction('remnant-tx-1'),
    ).resolves.toEqual({
      verified: false,
      status: 'INITIATED',
      transactionId: 'tx-1',
    });
    expect(prisma.transaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { escrowProviderStatus: 'paystack:verification_failed' },
      }),
    );
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });
});
