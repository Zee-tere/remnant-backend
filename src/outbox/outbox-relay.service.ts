import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SendMessageBatchCommand,
  SendMessageBatchRequestEntry,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { OutboxStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface ClaimedOutboxEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  messageId: string | null;
  clientMessageId: string | null;
  conversationId: string | null;
  recipientId: string | null;
  payload: Prisma.JsonValue;
  payloadVersion: number;
  attempts: number;
  createdAt: Date;
}

@Injectable()
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name);
  private readonly queueUrl: string | null;
  private readonly sqs: SQSClient;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.queueUrl =
      configService.get<string>('MESSAGING_EVENTS_QUEUE_URL') || null;
    this.sqs = new SQSClient({
      region:
        configService.get<string>('AWS_REGION') ||
        configService.get<string>('AWS_DEFAULT_REGION') ||
        'us-east-1',
    });
  }

  isConfigured() {
    return Boolean(this.queueUrl);
  }

  async relayPending(batchSize = 50) {
    if (!this.queueUrl) {
      return { configured: false, claimed: 0, published: 0, failed: 0 };
    }

    const safeBatchSize = Math.min(100, Math.max(1, batchSize));
    const events = await this.claim(safeBatchSize);
    let published = 0;
    let failed = 0;

    for (let offset = 0; offset < events.length; offset += 10) {
      const chunk = events.slice(offset, offset + 10);
      try {
        const result = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: this.queueUrl,
            Entries: chunk.map((event) => this.toSqsEntry(event)),
          }),
        );
        const failedIds = new Set(
          (result.Failed ?? []).map((entry) => entry.Id).filter(Boolean),
        );
        const successfulIds = chunk
          .filter((event) => !failedIds.has(event.id))
          .map((event) => event.id);
        const unsuccessful = chunk.filter((event) => failedIds.has(event.id));

        await Promise.all([
          this.markPublished(successfulIds),
          ...unsuccessful.map((event) =>
            this.releaseForRetry(event, 'SQS rejected this batch entry'),
          ),
        ]);
        published += successfulIds.length;
        failed += unsuccessful.length;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown SQS publish error';
        await Promise.all(
          chunk.map((event) => this.releaseForRetry(event, message)),
        );
        failed += chunk.length;
        this.logger.warn(`Outbox batch publish failed: ${message}`);
      }
    }

    return {
      configured: true,
      claimed: events.length,
      published,
      failed,
    };
  }

  private claim(limit: number) {
    return this.prisma.$queryRaw<ClaimedOutboxEvent[]>(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "OutboxEvent"
        WHERE (
          "status" = 'PENDING'::"OutboxStatus"
          AND "availableAt" <= CURRENT_TIMESTAMP
        ) OR (
          "status" = 'PROCESSING'::"OutboxStatus"
          AND "lockedAt" < CURRENT_TIMESTAMP - INTERVAL '5 minutes'
        )
        ORDER BY "createdAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "OutboxEvent" AS event
      SET
        "status" = 'PROCESSING'::"OutboxStatus",
        "lockedAt" = CURRENT_TIMESTAMP,
        "attempts" = event."attempts" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
      FROM candidates
      WHERE event."id" = candidates."id"
      RETURNING
        event."id",
        event."eventType",
        event."aggregateType",
        event."aggregateId",
        event."messageId",
        event."clientMessageId",
        event."conversationId",
        event."recipientId",
        event."payload",
        event."payloadVersion",
        event."attempts",
        event."createdAt"
    `);
  }

  private toSqsEntry(event: ClaimedOutboxEvent): SendMessageBatchRequestEntry {
    const entry: SendMessageBatchRequestEntry = {
      Id: event.id,
      MessageBody: JSON.stringify({
        eventId: event.id,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        messageId: event.messageId,
        clientMessageId: event.clientMessageId,
        conversationId: event.conversationId,
        recipientId: event.recipientId,
        payloadVersion: event.payloadVersion,
        occurredAt: event.createdAt.toISOString(),
        payload: event.payload,
      }),
    };
    if (this.queueUrl?.endsWith('.fifo')) {
      entry.MessageDeduplicationId = event.id;
      entry.MessageGroupId = event.conversationId || event.aggregateId;
    }
    return entry;
  }

  private async markPublished(ids: string[]) {
    if (ids.length === 0) return;
    await this.prisma.outboxEvent.updateMany({
      where: { id: { in: ids }, status: 'PROCESSING' },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        lockedAt: null,
        lastError: null,
      },
    });
  }

  private async releaseForRetry(event: ClaimedOutboxEvent, error: string) {
    const terminal = event.attempts >= 10;
    const delaySeconds = Math.min(900, 2 ** Math.min(event.attempts, 9));
    await this.prisma.outboxEvent.updateMany({
      where: { id: event.id, status: 'PROCESSING' },
      data: {
        status: terminal ? OutboxStatus.FAILED : OutboxStatus.PENDING,
        availableAt: new Date(Date.now() + delaySeconds * 1000),
        lockedAt: null,
        lastError: error.slice(0, 1000),
      },
    });
  }
}
