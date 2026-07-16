import { createHmac } from 'crypto';
import { PaystackService } from './paystack.service';

describe('PaystackService', () => {
  const secret = 'sk_test_remnant_payment_secret';
  const config = {
    get: jest.fn((key: string, fallback?: string) => {
      if (key === 'PAYSTACK_ENABLED') return 'true';
      if (key === 'PAYSTACK_SECRET_KEY') return secret;
      return fallback;
    }),
  };

  it('accepts only the matching HMAC-SHA512 webhook signature', () => {
    const service = new PaystackService(config as any);
    const body = Buffer.from('{"event":"charge.success"}');
    const signature = createHmac('sha512', secret).update(body).digest('hex');

    expect(service.verifyWebhookSignature(body, signature)).toBe(true);
    expect(service.verifyWebhookSignature(Buffer.from('{}'), signature)).toBe(
      false,
    );
    expect(service.verifyWebhookSignature(body, 'not-a-signature')).toBe(false);
  });
});
