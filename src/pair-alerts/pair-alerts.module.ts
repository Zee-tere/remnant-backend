import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MatchingModule } from '../matching/matching.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UploadModule } from '../upload/upload.module';
import { PairAlertsController } from './pair-alerts.controller';
import { PairAlertsService } from './pair-alerts.service';

@Module({
  imports: [AuthModule, MatchingModule, NotificationsModule, UploadModule],
  controllers: [PairAlertsController],
  providers: [PairAlertsService],
  exports: [PairAlertsService],
})
export class PairAlertsModule {}
