import { Module } from '@nestjs/common';
import { PairAlertsModule } from '../pair-alerts/pair-alerts.module';
import { MatchingJobsService } from './matching-jobs.service';
import { MatchingModule } from './matching.module';

@Module({
  imports: [MatchingModule, PairAlertsModule],
  providers: [MatchingJobsService],
  exports: [MatchingJobsService],
})
export class MatchingJobsModule {}
