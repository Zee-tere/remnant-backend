import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

interface PaystackResponse<T> {
  status: boolean;
  message: string;
  data?: T;
}

export interface PaystackInitialization {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export interface PaystackVerification {
  id: number;
  status: string;
  reference: string;
  amount: number;
  currency: string;
  paid_at?: string | null;
  channel?: string | null;
}

@Injectable()
export class PaystackService {
  constructor(private readonly configService: ConfigService) {}

  isEnabled() {
    return (
      this.configService.get<string>('PAYSTACK_ENABLED', 'false') === 'true' &&
      Boolean(this.configService.get<string>('PAYSTACK_SECRET_KEY'))
    );
  }

  async initializeTransaction(input: {
    email: string;
    amountKobo: number;
    reference: string;
    transactionId: string;
    listingId: string;
    listingTitle: string;
  }) {
    if (!Number.isSafeInteger(input.amountKobo) || input.amountKobo <= 0) {
      throw new BadRequestException('Payment amount is invalid');
    }

    const frontendUrl = this.configService
      .get<string>('FRONTEND_URL')
      ?.replace(/\/$/, '');
    const callbackUrl =
      this.configService.get<string>('PAYSTACK_CALLBACK_URL') ||
      (frontendUrl ? `${frontendUrl}/payment/callback` : undefined);
    if (!callbackUrl)
      throw new ServiceUnavailableException(
        'Payment callback URL is not configured.',
      );

    return this.request<PaystackInitialization>('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email: input.email,
        amount: String(input.amountKobo),
        currency: 'NGN',
        reference: input.reference,
        callback_url: callbackUrl,
        metadata: {
          transactionId: input.transactionId,
          listingId: input.listingId,
          listingTitle: input.listingTitle,
        },
      }),
    });
  }

  verifyTransaction(reference: string) {
    return this.request<PaystackVerification>(
      `/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: 'GET',
      },
    );
  }

  verifyWebhookSignature(rawBody: Buffer, signature?: string) {
    if (!signature || !/^[a-f0-9]{128}$/i.test(signature)) return false;
    const expected = createHmac('sha512', this.getSecret())
      .update(rawBody)
      .digest();
    const received = Buffer.from(signature, 'hex');
    return (
      received.length === expected.length && timingSafeEqual(received, expected)
    );
  }

  private async request<T>(path: string, init: RequestInit) {
    if (!this.isEnabled())
      throw new ServiceUnavailableException(
        'Paystack payments are not configured yet.',
      );

    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${this.getSecret()}`);
      headers.set('Content-Type', 'application/json');
      response = await fetch(`https://api.paystack.co${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new BadGatewayException(
        'The payment provider could not be reached. Please try again.',
      );
    }

    const payload = (await response
      .json()
      .catch(() => null)) as PaystackResponse<T> | null;
    if (!response.ok || !payload?.status || !payload.data) {
      throw new BadGatewayException(
        payload?.message ||
          'The payment provider could not complete this request.',
      );
    }
    return payload.data;
  }

  private getSecret() {
    const secret = this.configService.get<string>('PAYSTACK_SECRET_KEY');
    if (!secret)
      throw new ServiceUnavailableException(
        'Paystack payments are not configured yet.',
      );
    return secret;
  }
}
