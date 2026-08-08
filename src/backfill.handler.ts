import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MatchingJobsService } from './matching/matching-jobs.service';
import { MatchingService } from './matching/matching.service';

export const handler = async () => {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const matchingService = app.get(MatchingService);
    const matchingJobsService = app.get(MatchingJobsService);
    const queued = await matchingService.runDailyBackfill();
    const processed = await matchingJobsService.processPending(25);
    return { ...queued, processed };
  } finally {
    await app.close();
  }
};
