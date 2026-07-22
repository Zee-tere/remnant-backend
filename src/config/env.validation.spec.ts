import { validateEnvironment } from './env.validation';

const productionEnvironment = {
  NODE_ENV: 'production',
  DATABASE_URL:
    'postgresql://user:password@aws-1-us-east-1.pooler.supabase.com:6543/postgres',
  COGNITO_USER_POOL_ID: 'us-east-1_example',
  COGNITO_CLIENT_ID: 'example-client-id',
  COGNITO_HOSTED_UI_DOMAIN:
    'https://example.auth.us-east-1.amazoncognito.com',
  FRONTEND_URL: 'https://remnantmarket.co',
  ALLOWED_ORIGINS:
    'https://remnantmarket.co,https://www.remnantmarket.co',
  AWS_REGION: 'us-east-1',
  AWS_S3_BUCKET: 'remnant-uploads-prod',
  ESCROW_ENABLED: 'false',
  PAYSTACK_ENABLED: 'false',
};

describe('validateEnvironment', () => {
  it('keeps the core API available when optional guest messaging is not configured', () => {
    expect(() => validateEnvironment(productionEnvironment)).not.toThrow();
  });

  it('accepts a configured guest messaging secret without making it global', () => {
    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        GUEST_ACCESS_SECRET: 'a'.repeat(64),
      }),
    ).not.toThrow();
  });
});
