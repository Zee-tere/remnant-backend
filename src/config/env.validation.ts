type Environment = Record<string, unknown>;

function read(config: Environment, key: string) {
  const value = config[key];
  return typeof value === 'string' ? value.trim() : '';
}

function assertPresent(config: Environment, key: string, errors: string[]) {
  const value = read(config, key);
  if (!value || value.startsWith('REPLACE_WITH_') || value.startsWith('your_')) {
    errors.push(`${key} is required`);
  }
}

function assertProductionUrl(config: Environment, key: string, errors: string[]) {
  const value = read(config, key);
  if (!value) {
    errors.push(`${key} is required`);
    return;
  }

  try {
    const url = new URL(value);
    const localHostnames = new Set(['localhost', '127.0.0.1', '0.0.0.0']);
    if (url.protocol !== 'https:' || localHostnames.has(url.hostname)) {
      errors.push(`${key} must be a public https URL in production`);
    }
  } catch {
    errors.push(`${key} must be a valid URL`);
  }
}

function assertSupabaseDatabase(config: Environment, errors: string[]) {
  const value = read(config, 'DATABASE_URL');
  if (!value) {
    errors.push('DATABASE_URL is required');
    return;
  }

  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(value)) {
    errors.push('DATABASE_URL must point to the Supabase PostgreSQL pooler in production');
  }

  if (!/6543|pooler|supabase/i.test(value)) {
    errors.push('DATABASE_URL should use the Supabase pooler connection string for Lambda runtime');
  }
}

export function validateEnvironment(config: Environment) {
  const nodeEnv = read(config, 'NODE_ENV') || 'development';
  const errors: string[] = [];

  if (nodeEnv === 'production') {
    [
      'DATABASE_URL',
      'COGNITO_USER_POOL_ID',
      'COGNITO_CLIENT_ID',
      'FRONTEND_URL',
      'ALLOWED_ORIGINS',
      'AWS_REGION',
      'AWS_S3_BUCKET',
      'EMAIL_FROM',
      'OPENAI_API_KEY',
      'SUPABASE_JWT_SECRET',
      'SUPABASE_URL',
      'ESCROW_ENABLED',
    ].forEach((key) => assertPresent(config, key, errors));

    assertSupabaseDatabase(config, errors);
    assertProductionUrl(config, 'FRONTEND_URL', errors);
    assertProductionUrl(config, 'SUPABASE_URL', errors);

    if (read(config, 'ESCROW_ENABLED') === 'true') {
      ['ESCROW_API_EMAIL', 'ESCROW_API_KEY', 'ESCROW_WEBHOOK_SECRET'].forEach((key) =>
        assertPresent(config, key, errors),
      );
    }

    if (read(config, 'ESCROW_ALLOW_STUB') === 'true') {
      errors.push('ESCROW_ALLOW_STUB must be false in production');
    }
  }

  if (errors.length) {
    throw new Error(`Invalid environment configuration:\n- ${errors.join('\n- ')}`);
  }

  return config;
}
