import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MatchingJobsService } from './matching/matching-jobs.service';
import { MatchingService } from './matching/matching.service';
import { UploadService } from './upload/upload.service';
import { UserService } from './user/user.service';
import { ListingsService } from './listings/listings.service';

export const handler = async () => {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const matchingService = app.get(MatchingService);
    const matchingJobsService = app.get(MatchingJobsService);
    const uploadService = app.get(UploadService);
    const userService = app.get(UserService);
    const listingsService = app.get(ListingsService);
    const queued = await matchingService.runDailyBackfill();
    const processed = await matchingJobsService.processPending(25);
    const uploads = await uploadService.cleanupPendingUploads();
    const deletions = await userService.purgeExpiredDeletionRequests();
    const listings = await listingsService.expireListings();
    return { ...queued, processed, uploads, deletions, listings };
  } finally {
    await app.close();
  }
};
