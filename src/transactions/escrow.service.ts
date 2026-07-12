import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface EscrowParty {
  email: string;
  name: string;
}

interface EscrowCreateResult {
  id: string;
  status?: string;
  checkoutUrl?: string | null;
  raw: unknown;
}

type EscrowAction =
  | 'agree'
  | 'ship'
  | 'receive'
  | 'accept'
  | 'reject'
  | 'cancel'
  | 'ship_return'
  | 'receive_return'
  | 'accept_return'
  | 'reject_return';

@Injectable()
export class EscrowService {
  private readonly apiEmail: string;
  private readonly apiKey: string;
  private readonly allowStub: boolean;
  private readonly baseUrl: string;
  private readonly currency: string;
  private readonly itemCategory: string;
  private readonly inspectionPeriodSeconds: number;

  constructor(private configService: ConfigService) {
    this.apiEmail = this.configService.get<string>('ESCROW_API_EMAIL', '');
    this.apiKey = this.configService.get<string>('ESCROW_API_KEY', '');
    const stubDefault = this.configService.get<string>('NODE_ENV') === 'production' ? 'false' : 'true';
    this.allowStub = this.configService.get<string>('ESCROW_ALLOW_STUB', stubDefault) === 'true';
    this.baseUrl = this.configService.get<string>('ESCROW_API_URL', 'https://api.escrow-sandbox.com/2017-09-01');
    this.currency = this.configService.get<string>('ESCROW_CURRENCY', 'usd').toLowerCase();
    this.itemCategory = this.configService.get<string>('ESCROW_ITEM_CATEGORY', 'other_merchandise');
    this.inspectionPeriodSeconds = parseInt(
      this.configService.get<string>('ESCROW_INSPECTION_PERIOD_SECONDS', '259200'),
      10,
    );
  }

  async createEscrowTransaction(
    buyer: EscrowParty,
    seller: EscrowParty,
    amount: number,
    description: string,
    merchantUrl?: string,
    imageUrl?: string,
  ): Promise<EscrowCreateResult> {
    if (!this.isConfigured()) {
      return this.stubOrThrow('created', { amount, description });
    }

    this.assertSupportedCurrency();

    const response = await fetch(`${this.baseUrl}/transaction`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        parties: [
          { role: 'buyer', customer: buyer.email },
          { role: 'seller', customer: seller.email },
        ],
        currency: this.currency,
        description,
        items: [
          {
            title: description,
            description,
            category: this.itemCategory,
            quantity: 1,
            type: 'general_merchandise',
            inspection_period: this.inspectionPeriodSeconds,
            extra_attributes: {
              ...(merchantUrl ? { merchant_url: merchantUrl } : {}),
              ...(imageUrl ? { image_url: imageUrl } : {}),
            },
            schedule: [
              {
                amount,
                payer_customer: buyer.email,
                beneficiary_customer: seller.email,
              },
            ],
          },
        ],
      }),
    });

    const payload = await this.parseResponse(response);
    const id = this.readString(payload, ['id', 'transaction_id']);
    if (!id) throw new BadRequestException('Escrow provider did not return a transaction id');

    return {
      id,
      status: this.readString(payload, ['status']),
      checkoutUrl: this.extractNextStep(payload, 'buyer') ?? this.readString(payload, ['checkout_url', 'landing_page', 'url']),
      raw: payload,
    };
  }

  async getEscrowTransaction(escrowId: string) {
    if (!this.isConfigured()) return this.stubOrThrow('stub', { id: escrowId });

    const response = await fetch(`${this.baseUrl}/transaction/${escrowId}`, {
      headers: this.headers(false),
    });

    return this.parseResponse(response);
  }

  async markShipped(escrowId: string, sellerEmail: string, trackingInfo?: string) {
    return this.patchTransaction(escrowId, 'ship', sellerEmail, {
      shipping_information: {
        ...(trackingInfo ? { tracking_information: trackingInfo } : {}),
      },
    });
  }

  async markReceived(escrowId: string, buyerEmail: string) {
    return this.patchTransaction(escrowId, 'receive', buyerEmail);
  }

  async acceptItems(escrowId: string, buyerEmail: string) {
    return this.patchTransaction(escrowId, 'accept', buyerEmail);
  }

  async cancelTransaction(escrowId: string, reason: string) {
    return this.patchTransaction(escrowId, 'cancel', undefined, {
      cancel_information: { cancellation_reason: reason },
    });
  }

  normalizeWebhook(payload: Record<string, unknown>) {
    const event =
      this.readString(payload, ['event']) ??
      this.readString(payload, ['status']) ??
      'unknown';
    const eventType = this.readString(payload, ['event_type', 'type']) ?? 'transaction';
    const providerEventId = this.readString(payload, ['id', 'event_id']);
    const escrowTransactionId =
      this.readString(payload, ['transaction_id', 'transactionId']) ??
      this.readString((payload.transaction as Record<string, unknown>) ?? {}, ['id', 'transaction_id']);

    return { event, eventType, providerEventId, escrowTransactionId };
  }

  isPaymentApprovedEvent(event?: string) {
    return event === 'payment_approved';
  }

  isShippedEvent(event?: string) {
    return event === 'ship';
  }

  isReceivedEvent(event?: string) {
    return event === 'receive';
  }

  isAcceptedOrCompleteEvent(event?: string) {
    return Boolean(event && ['accept', 'complete', 'payment_disbursed'].includes(event));
  }

  isRefundedOrCancelledEvent(event?: string) {
    return Boolean(event && ['payment_refunded', 'refund_resolved', 'cancel'].includes(event));
  }

  canUseStubCheckout() {
    return this.allowStub && !this.isConfigured();
  }

  isStubTransactionId(escrowId?: string | null) {
    return Boolean(escrowId?.startsWith('stub-escrow-'));
  }

  private async patchTransaction(
    escrowId: string,
    action: EscrowAction,
    asCustomer?: string,
    extraBody?: Record<string, unknown>,
  ) {
    if (!this.isConfigured()) return this.stubOrThrow(action, { id: escrowId });

    const response = await fetch(`${this.baseUrl}/transaction/${escrowId}`, {
      method: 'PATCH',
      headers: this.headers(true, asCustomer),
      body: JSON.stringify({ action, ...extraBody }),
    });

    return this.parseResponse(response);
  }

  private isConfigured() {
    return Boolean(this.apiEmail && this.apiKey);
  }

  private stubOrThrow(status: string, details: Record<string, unknown>) {
    if (!this.allowStub) {
      throw new ServiceUnavailableException('Escrow provider is not configured');
    }

    return {
      id: String(details.id ?? `stub-escrow-${Date.now()}`),
      status,
      checkoutUrl: null,
      raw: { status, ...details },
    };
  }

  private assertSupportedCurrency() {
    const supported = new Set(['usd', 'aud', 'euro', 'gbp', 'cad']);
    if (!supported.has(this.currency)) {
      throw new BadRequestException(`Escrow.com does not support currency ${this.currency}`);
    }
  }

  private headers(includeContentType = true, asCustomer?: string) {
    return {
      ...(includeContentType ? { 'Content-Type': 'application/json' } : {}),
      ...(asCustomer ? { 'As-Customer': asCustomer } : {}),
      Authorization: `Basic ${Buffer.from(`${this.apiEmail}:${this.apiKey}`).toString('base64')}`,
    };
  }

  private async parseResponse(response: Response) {
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new BadRequestException({
        message: 'Escrow provider request failed',
        status: response.status,
        payload,
      });
    }
    return payload as Record<string, unknown>;
  }

  private extractNextStep(payload: Record<string, unknown>, role: string) {
    const parties = payload.parties;
    if (!Array.isArray(parties)) return undefined;
    const party = parties.find((item) => {
      return item && typeof item === 'object' && (item as { role?: unknown }).role === role;
    }) as Record<string, unknown> | undefined;

    return party ? this.readString(party, ['next_step']) : undefined;
  }

  private readString(source: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) return value;
      if (typeof value === 'number') return String(value);
    }
    return undefined;
  }
}
