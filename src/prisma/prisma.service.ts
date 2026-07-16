import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

export function prepareDatabaseUrl(): string | undefined;
export function prepareDatabaseUrl(value: string): string;
export function prepareDatabaseUrl(value = process.env.DATABASE_URL) {
  if (!value) return value;

  try {
    const url = new URL(value);
    const usesTransactionPooler = url.port === '6543' || url.hostname.includes('pooler.supabase.com');
    if (!usesTransactionPooler) return value;

    url.searchParams.set('pgbouncer', 'true');
    url.searchParams.set('statement_cache_size', '0');
    if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', '1');
    return url.toString();
  } catch {
    return value;
  }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const url = prepareDatabaseUrl();
    super(url ? { datasources: { db: { url } } } : undefined);
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
