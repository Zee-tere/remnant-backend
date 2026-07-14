import { prepareDatabaseUrl } from './prisma.service';

describe('prepareDatabaseUrl', () => {
  it('enables pooler-safe Prisma settings for the Supabase transaction pooler', () => {
    const result = prepareDatabaseUrl(
      'postgresql://user:password@aws-1-us-east-1.pooler.supabase.com:6543/postgres',
    );
    const url = new URL(result);

    expect(url.searchParams.get('pgbouncer')).toBe('true');
    expect(url.searchParams.get('connection_limit')).toBe('1');
  });

  it('preserves an explicit connection limit', () => {
    const result = prepareDatabaseUrl(
      'postgresql://user:password@pooler.supabase.com:6543/postgres?connection_limit=2',
    );

    expect(new URL(result).searchParams.get('connection_limit')).toBe('2');
  });

  it('does not alter direct database connections', () => {
    const value = 'postgresql://user:password@db.example.com:5432/postgres';
    expect(prepareDatabaseUrl(value)).toBe(value);
  });
});
