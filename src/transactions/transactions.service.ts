import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger } from '@nestjs/common';
import { Prisma, TransactionStatus } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EscrowService } from './escrow.service';

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);
  private readonly platformFeePercent: number;
  private readonly acceptOnConfirm: boolean;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private escrowService: EscrowService,
    private notificationsService: NotificationsService,
  ) {
    this.platformFeePercent = parseFloat(
      this.configService.get<string>('PLATFORM_FEE_PERCENTAGE', '4'),
    );
    this.acceptOnConfirm = this.configService.get<string>('ESCROW_ACCEPT_ON_CONFIRM', 'false') === 'true';
  }

  private get escrowEnabled(): boolean {
    return this.configService.get<string>('ESCROW_ENABLED', 'false') === 'true';
  }

  async initiateTransaction(buyerId: string, listingId: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      include: { user: true },
    });
    if (!listing) throw new NotFoundException('Listing not found');
    if (listing.status !== 'ACTIVE') throw new BadRequestException('Listing is not active');
    if (listing.userId === buyerId) throw new ForbiddenException('Cannot buy your own listing');
    if (listing.user.email.endsWith('@guest.remnant.local')) {
      throw new BadRequestException('The seller must create a profile before an order can be placed.');
    }
    if (listing.intentionTag !== 'SELL') throw new BadRequestException('Only sale listings can create an order');
    if (!listing.price) throw new BadRequestException('Listing has no price');

    const existingTransaction = await this.prisma.transaction.findFirst({
      where: {
        listingId,
        buyerId,
        status: { in: ['INITIATED', 'FUNDED', 'SHIPPED', 'RECEIVED', 'DISPUTED'] },
      },
      include: this.transactionIncludes(),
    });
    if (existingTransaction) return existingTransaction;

    const amount = listing.price;
    const platformFee = new Prisma.Decimal(
      (Number(amount) * this.platformFeePercent) / 100,
    );

    const buyer = await this.prisma.user.findUnique({ where: { id: buyerId } });
    if (!buyer) throw new NotFoundException('Buyer not found');

    if (!this.escrowEnabled) {
      this.logger.warn('Escrow disabled: ESCROW_ENABLED=false');

      const transaction = await this.prisma.transaction.create({
        data: {
          listingId,
          buyerId,
          sellerId: listing.userId,
          amount,
          platformFee,
          escrowProviderStatus: 'disabled',
          status: 'INITIATED',
        },
        include: this.transactionIncludes(),
      });

      await this.notificationsService.createNotification(
        listing.userId,
        'TRANSACTION_UPDATE',
        'Transaction started',
        `${buyer.name} started a transaction for ${listing.title}. Escrow is disabled for launch.`,
        `/transactions/${transaction.id}`,
      );

      return transaction;
    }

    const escrowResult = await this.escrowService.createEscrowTransaction(
      { email: buyer.email, name: buyer.name },
      { email: listing.user.email, name: listing.user.name },
      Number(amount),
      listing.title,
      undefined,
      listing.images[0],
    );

    const transaction = await this.prisma.transaction.create({
      data: {
        listingId,
        buyerId,
        sellerId: listing.userId,
        amount,
        platformFee,
        escrowTransactionId: escrowResult.id,
        escrowCheckoutUrl: escrowResult.checkoutUrl ?? null,
        escrowProviderStatus: escrowResult.status ?? null,
        status: 'INITIATED',
      },
      include: this.transactionIncludes(),
    });

    const checkoutReadyTransaction = this.escrowService.canUseStubCheckout()
      ? await this.prisma.transaction.update({
          where: { id: transaction.id },
          data: {
            escrowCheckoutUrl: `/transactions/${transaction.id}/stub-checkout`,
            escrowProviderStatus: escrowResult.status ?? 'stub_created',
          },
          include: this.transactionIncludes(),
        })
      : transaction;

    await this.notificationsService.createNotification(
      listing.userId,
      'TRANSACTION_UPDATE',
      'Escrow transaction started',
      `${buyer.name} started escrow for ${listing.title}. Wait for funding before shipping.`,
      `/transactions/${transaction.id}`,
    );

    return checkoutReadyTransaction;
  }

  async getTransaction(id: string, userId: string) {
    const tx = await this.prisma.transaction.findUnique({
      where: { id },
      include: this.transactionIncludes(),
    });
    if (!tx) throw new NotFoundException('Transaction not found');
    if (tx.buyerId !== userId && tx.sellerId !== userId) {
      throw new ForbiddenException('Not your transaction');
    }
    return tx;
  }

  async getUserTransactions(userId: string) {
    return this.prisma.transaction.findMany({
      where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
      include: this.transactionIncludes(),
      orderBy: { createdAt: 'desc' },
    });
  }

  async markShipped(id: string, sellerId: string, trackingInfo?: string) {
    const tx = await this.prisma.transaction.findUnique({
      where: { id },
      include: { seller: { select: { email: true } } },
    });
    if (!tx) throw new NotFoundException('Transaction not found');
    if (tx.sellerId !== sellerId) throw new ForbiddenException('Only seller can mark as shipped');
    if (this.escrowEnabled && tx.status !== 'FUNDED') {
      throw new BadRequestException('Escrow must be funded before shipment');
    }
    if (!this.escrowEnabled && !['INITIATED', 'FUNDED'].includes(tx.status)) {
      throw new BadRequestException('Transaction cannot be shipped in current state');
    }
    if (this.escrowEnabled && !tx.escrowTransactionId) throw new BadRequestException('Transaction has no escrow id');

    if (this.escrowEnabled) {
      await this.escrowService.markShipped(tx.escrowTransactionId!, tx.seller.email, trackingInfo);
    }

    const updated = await this.prisma.transaction.update({
      where: { id },
      data: {
        status: 'SHIPPED',
        trackingInfo: trackingInfo || null,
        shippedAt: new Date(),
      },
      include: this.transactionIncludes(),
    });

    await this.notificationsService.createNotification(
      tx.buyerId,
      'TRANSACTION_UPDATE',
      'Item marked as shipped',
      'Confirm receipt only after you receive and inspect the item.',
      `/transactions/${id}`,
    );

    return updated;
  }

  async fundStubTransaction(id: string, buyerId: string) {
    const tx = await this.prisma.transaction.findUnique({ where: { id } });
    if (!tx) throw new NotFoundException('Transaction not found');
    if (tx.buyerId !== buyerId) throw new ForbiddenException('Only buyer can fund this transaction');
    if (tx.status !== 'INITIATED') {
      throw new BadRequestException('Only initiated transactions can be funded');
    }
    if (!this.escrowEnabled) {
      return this.markFundedFromProvider(id, 'local_funded');
    }

    if (!this.escrowService.canUseStubCheckout() || !this.escrowService.isStubTransactionId(tx.escrowTransactionId)) {
      throw new BadRequestException('Sandbox escrow funding is not available for this transaction');
    }

    return this.markFundedFromProvider(id, 'stub_payment_approved');
  }

  async confirmReceipt(id: string, buyerId: string) {
    const tx = await this.prisma.transaction.findUnique({
      where: { id },
      include: { listing: true, buyer: true, seller: true },
    });
    if (!tx) throw new NotFoundException('Transaction not found');
    if (tx.buyerId !== buyerId) throw new ForbiddenException('Only buyer can confirm receipt');
    if (tx.status !== 'SHIPPED') {
      throw new BadRequestException('Transaction must be shipped before confirming receipt');
    }
    if (!this.escrowEnabled) {
      const completed = await this.completeTransaction(id, 'local_complete');

      await this.notificationsService.createNotification(
        tx.sellerId,
        'TRANSACTION_UPDATE',
        'Transaction complete',
        `${tx.buyer.name} confirmed receipt.`,
        `/transactions/${id}`,
      );

      return completed;
    }

    if (!tx.escrowTransactionId) throw new BadRequestException('Transaction has no escrow id');

    const receiveResult = await this.escrowService.markReceived(tx.escrowTransactionId, tx.buyer.email);

    if (!this.acceptOnConfirm) {
      const received = await this.prisma.transaction.update({
        where: { id },
        data: {
          status: 'RECEIVED',
          receivedAt: new Date(),
          escrowProviderStatus: this.readStatus(receiveResult) ?? 'receive',
        },
        include: this.transactionIncludes(),
      });

      await this.notificationsService.createNotification(
        tx.sellerId,
        'TRANSACTION_UPDATE',
        'Buyer marked item received',
        'The buyer marked the item received. Funds are released only after Escrow.com acceptance/disbursement.',
        `/transactions/${id}`,
      );

      return received;
    }

    const acceptResult = await this.escrowService.acceptItems(tx.escrowTransactionId, tx.buyer.email);
    const completed = await this.completeTransaction(id, this.readStatus(acceptResult) ?? 'accept');

    await this.notificationsService.createNotification(
      tx.sellerId,
      'TRANSACTION_UPDATE',
      'Escrow accepted',
      `${tx.buyer.name} accepted the item. Escrow.com can now disburse funds.`,
      `/transactions/${id}`,
    );

    return completed;
  }

  async disputeTransaction(id: string, userId: string) {
    const tx = await this.prisma.transaction.findUnique({ where: { id } });
    if (!tx) throw new NotFoundException('Transaction not found');
    if (tx.buyerId !== userId && tx.sellerId !== userId) {
      throw new ForbiddenException('Not your transaction');
    }
    if (!['FUNDED', 'SHIPPED', 'RECEIVED'].includes(tx.status)) {
      throw new BadRequestException('Cannot dispute transaction in current state');
    }

    const updated = await this.prisma.transaction.update({
      where: { id },
      data: { status: 'DISPUTED', disputedAt: new Date() },
      include: this.transactionIncludes(),
    });

    const otherUserId = tx.buyerId === userId ? tx.sellerId : tx.buyerId;
    await this.notificationsService.createNotification(
      otherUserId,
      'TRANSACTION_UPDATE',
      'Transaction disputed',
      'A dispute was opened. Keep all communication and evidence inside Remnant.',
      `/transactions/${id}`,
    );

    return updated;
  }

  async refundTransaction(id: string, adminUserId?: string) {
    const tx = await this.prisma.transaction.findUnique({ where: { id } });
    if (!tx) throw new NotFoundException('Transaction not found');
    if (!['INITIATED', 'FUNDED', 'DISPUTED'].includes(tx.status)) {
      throw new BadRequestException('Transaction cannot be refunded in current state');
    }
    if (this.escrowEnabled && !tx.escrowTransactionId) throw new BadRequestException('Transaction has no escrow id');

    if (!this.escrowEnabled) {
      const updated = await this.prisma.transaction.update({
        where: { id },
        data: {
          status: 'REFUNDED',
          refundedAt: new Date(),
          escrowProviderStatus: 'local_refunded',
        },
        include: this.transactionIncludes(),
      });

      await Promise.all([
        this.notificationsService.createNotification(
          tx.buyerId,
          'TRANSACTION_UPDATE',
          'Transaction refunded',
          'The transaction has been refunded locally.',
          `/transactions/${id}`,
        ),
        this.notificationsService.createNotification(
          tx.sellerId,
          'TRANSACTION_UPDATE',
          'Transaction refunded',
          'The transaction has been refunded locally.',
          `/transactions/${id}`,
        ),
      ]);

      return updated;
    }

    if (tx.status !== 'INITIATED') {
      throw new BadRequestException('Funded or disputed escrow refunds must be resolved in Escrow.com and synced by webhook');
    }

    const refundResult = await this.escrowService.cancelTransaction(
      tx.escrowTransactionId!,
      'Cancelled from Remnant admin',
    );
    const updated = await this.prisma.transaction.update({
      where: { id },
      data: {
        status: 'REFUNDED',
        refundedAt: new Date(),
        escrowProviderStatus: this.readStatus(refundResult) ?? 'refunded',
      },
      include: this.transactionIncludes(),
    });

    await Promise.all([
      this.notificationsService.createNotification(
        tx.buyerId,
        'TRANSACTION_UPDATE',
        'Transaction refunded',
        'Your escrow transaction has been refunded.',
        `/transactions/${id}`,
      ),
      this.notificationsService.createNotification(
        tx.sellerId,
        'TRANSACTION_UPDATE',
        'Transaction refunded',
        'The escrow transaction has been refunded and should not be shipped.',
        `/transactions/${id}`,
      ),
    ]);

    console.log(`[ESCROW] Refund processed for ${id}${adminUserId ? ` by ${adminUserId}` : ''}.`);
    return updated;
  }

  async handleEscrowWebhook(payload: Record<string, unknown>) {
    if (!this.escrowEnabled) {
      return { received: true, note: 'escrow disabled' };
    }

    const normalized = this.escrowService.normalizeWebhook(payload);
    const transaction = normalized.escrowTransactionId
      ? await this.prisma.transaction.findFirst({
          where: { escrowTransactionId: normalized.escrowTransactionId },
        })
      : null;

    const eventData = {
      transactionId: transaction?.id ?? null,
      provider: 'escrow.com',
      eventType: `${normalized.eventType}:${normalized.event}`,
      providerEventId: normalized.providerEventId ?? null,
      payload: payload as Prisma.InputJsonObject,
    };

    if (normalized.providerEventId) {
      await this.prisma.escrowEvent.upsert({
        where: {
          provider_providerEventId: {
            provider: eventData.provider,
            providerEventId: normalized.providerEventId,
          },
        },
        create: eventData,
        update: { payload: eventData.payload, transactionId: eventData.transactionId },
      });
    } else {
      await this.prisma.escrowEvent.create({ data: eventData });
    }

    if (!transaction) {
      return { recorded: true, matchedTransaction: false };
    }

    let verifiedStatus = normalized.event;
    if (normalized.escrowTransactionId) {
      try {
        const providerTransaction = await this.escrowService.getEscrowTransaction(normalized.escrowTransactionId);
        verifiedStatus = this.readProviderState(providerTransaction) ?? normalized.event;
      } catch (error) {
        console.warn(`[ESCROW] Could not verify webhook transaction ${normalized.escrowTransactionId}`, error);
      }
    }

    if (this.escrowService.isPaymentApprovedEvent(normalized.event) && transaction.status === 'INITIATED') {
      await this.markFundedFromProvider(transaction.id, verifiedStatus);
      return { recorded: true, matchedTransaction: true, status: 'FUNDED' };
    }

    if (this.escrowService.isShippedEvent(normalized.event) && transaction.status === 'FUNDED') {
      await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'SHIPPED',
          shippedAt: new Date(),
          escrowProviderStatus: verifiedStatus,
        },
      });
      return { recorded: true, matchedTransaction: true, status: 'SHIPPED' };
    }

    if (this.escrowService.isReceivedEvent(normalized.event) && transaction.status === 'SHIPPED') {
      await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'RECEIVED',
          receivedAt: new Date(),
          escrowProviderStatus: verifiedStatus,
        },
      });
      return { recorded: true, matchedTransaction: true, status: 'RECEIVED' };
    }

    if (this.escrowService.isAcceptedOrCompleteEvent(normalized.event) && transaction.status !== 'COMPLETE') {
      await this.completeTransaction(transaction.id, verifiedStatus);
      return { recorded: true, matchedTransaction: true, status: 'COMPLETE' };
    }

    if (this.escrowService.isRefundedOrCancelledEvent(normalized.event) && transaction.status !== 'REFUNDED') {
      await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'REFUNDED',
          refundedAt: new Date(),
          escrowProviderStatus: verifiedStatus,
        },
      });
      return { recorded: true, matchedTransaction: true, status: 'REFUNDED' };
    }

    await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: { escrowProviderStatus: verifiedStatus ?? normalized.event },
    });

    return { recorded: true, matchedTransaction: true };
  }

  private async markFundedFromProvider(id: string, providerStatus?: string) {
    const tx = await this.prisma.transaction.update({
      where: { id },
      data: {
        status: 'FUNDED',
        fundedAt: new Date(),
        escrowProviderStatus: providerStatus ?? 'funded',
      },
      include: this.transactionIncludes(),
    });

    await this.notificationsService.createNotification(
      tx.sellerId,
      'TRANSACTION_UPDATE',
      'Escrow funded',
      'Funds are secured. You can now ship or arrange handoff.',
      `/transactions/${id}`,
    );

    return tx;
  }

  private async completeTransaction(id: string, providerStatus?: string) {
    return this.prisma.$transaction(async (prisma) => {
      const tx = await prisma.transaction.update({
        where: { id },
        data: {
          status: 'COMPLETE',
          completedAt: new Date(),
          escrowProviderStatus: providerStatus ?? 'complete',
        },
        include: this.transactionIncludes(),
      });

      await prisma.listing.update({
        where: { id: tx.listingId },
        data: { status: 'COMPLETED' },
      });

      await prisma.match.updateMany({
        where: {
          OR: [{ listingAId: tx.listingId }, { listingBId: tx.listingId }],
          status: { not: 'DISMISSED' },
        },
        data: { status: 'COMPLETED' },
      });

      return tx;
    });
  }

  private transactionIncludes() {
    return {
      listing: { select: { id: true, title: true, slug: true, images: true } },
      buyer: { select: { id: true, name: true, avatarUrl: true } },
      seller: { select: { id: true, name: true, avatarUrl: true } },
    };
  }

  private readStatus(result: unknown) {
    if (!result || typeof result !== 'object') return undefined;
    const status = (result as { status?: unknown }).status;
    return typeof status === 'string' ? status : undefined;
  }

  private readProviderState(result: unknown) {
    if (!result || typeof result !== 'object') return undefined;
    const transaction = result as {
      status?: unknown;
      items?: Array<{ status?: Record<string, boolean>; schedule?: Array<{ status?: Record<string, boolean> }> }>;
    };

    if (typeof transaction.status === 'string') return transaction.status;

    const item = transaction.items?.[0];
    const itemStatus = item?.status;
    const scheduleStatus = item?.schedule?.[0]?.status;

    if (itemStatus?.accepted) return 'accepted';
    if (itemStatus?.received) return 'received';
    if (itemStatus?.shipped) return 'shipped';
    if (itemStatus?.canceled) return 'cancelled';
    if (scheduleStatus?.secured) return 'payment_approved';
    return undefined;
  }
}
