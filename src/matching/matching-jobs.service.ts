import { Injectable, Logger } from '@nestjs/common';
import { MatchingJobStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PairAlertsService } from '../pair-alerts/pair-alerts.service';
import { MatchingService } from './matching.service';

interface ClaimedMatchingJob {
  id: string;
  entityType: 'Listing' | 'PairAlert';
  entityId: string;
  entityVersion: number;
  reason: string;
  attempts: number;
}

@Injectable()
export class MatchingJobsService {
  private readonly logger = new Logger(MatchingJobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly matchingService: MatchingService,
    private readonly pairAlertsService: PairAlertsService,
  ) {}

  enqueueListing(
    client: Prisma.TransactionClient,
    listingId: string,
    entityVersion: number,
    reason: string,
  ) {
    return client.matchingJob.upsert({
      where: {
        entityType_entityId_entityVersion: {
          entityType: 'Listing',
          entityId: listingId,
          entityVersion,
        },
      },
      create: {
        entityType: 'Listing',
        entityId: listingId,
        entityVersion,
        reason,
      },
      update: {},
    });
  }

  async processPending(batchSize = 10) {
    const jobs = await this.claim(Math.min(25, Math.max(1, batchSize)));
    let completed = 0;
    let failed = 0;

    for (const job of jobs) {
      try {
        await this.process(job);
        await this.prisma.matchingJob.updateMany({
          where: { id: job.id, status: 'PROCESSING' },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            lockedAt: null,
            lastError: null,
          },
        });
        completed += 1;
      } catch (error) {
        failed += 1;
        await this.releaseForRetry(job, this.errorMessage(error));
      }
    }

    return { claimed: jobs.length, completed, failed };
  }

  private async process(job: ClaimedMatchingJob) {
    if (job.entityType === 'PairAlert') {
      const alert = await this.prisma.pairAlert.findUnique({
        where: { id: job.entityId },
        select: { version: true, status: true },
      });
      if (!alert || alert.status !== 'ACTIVE' || alert.version !== job.entityVersion) return;
      await this.pairAlertsService.runMatchForAlert(job.entityId, job.reason, job.entityVersion);
      return;
    }

    const listing = await this.prisma.listing.findUnique({
      where: { id: job.entityId },
      select: { version: true, status: true, intentionTag: true },
    });
    if (
      !listing ||
      listing.status !== 'ACTIVE' ||
      listing.intentionTag === 'WANTED' ||
      listing.version !== job.entityVersion
    ) {
      return;
    }

    const errors: string[] = [];
    try {
      await this.matchingService.runMatchForListing(job.entityId, job.reason, job.entityVersion);
    } catch (error) {
      errors.push(this.errorMessage(error));
    }
    try {
      await this.pairAlertsService.runMatchForListing(job.entityId, job.reason, job.entityVersion);
    } catch (error) {
      errors.push(this.errorMessage(error));
    }
    if (errors.length > 0) throw new Error(errors.join('; '));
  }

  private claim(limit: number) {
    return this.prisma.$queryRaw<ClaimedMatchingJob[]>(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "MatchingJob"
        WHERE (
          "status" = 'PENDING'::"MatchingJobStatus"
          AND "availableAt" <= CURRENT_TIMESTAMP
        ) OR (
          "status" = 'PROCESSING'::"MatchingJobStatus"
          AND "lockedAt" < CURRENT_TIMESTAMP - INTERVAL '5 minutes'
        )
        ORDER BY "createdAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "MatchingJob" AS job
      SET
        "status" = 'PROCESSING'::"MatchingJobStatus",
        "lockedAt" = CURRENT_TIMESTAMP,
        "attempts" = job."attempts" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
      FROM candidates
      WHERE job."id" = candidates."id"
      RETURNING
        job."id",
        job."entityType",
        job."entityId",
        job."entityVersion",
        job."reason",
        job."attempts"
    `);
  }

  private async releaseForRetry(job: ClaimedMatchingJob, error: string) {
    const terminal = job.attempts >= 8;
    const delaySeconds = Math.min(900, 2 ** Math.min(job.attempts, 9));
    await this.prisma.matchingJob.updateMany({
      where: { id: job.id, status: 'PROCESSING' },
      data: {
        status: terminal ? MatchingJobStatus.FAILED : MatchingJobStatus.PENDING,
        availableAt: new Date(Date.now() + delaySeconds * 1000),
        lockedAt: null,
        lastError: error.slice(0, 1000),
      },
    });
    this.logger.warn(`Matching job ${job.id} failed: ${error}`);
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
