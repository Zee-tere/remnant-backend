import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MatchingService } from './matching/matching.service';

export const handler = async () => {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const matchingService = app.get(MatchingService);
    return await matchingService.runDailyBackfill();
  } finally {
    await app.close();
  }
};
