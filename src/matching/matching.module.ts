import { Module } from '@nestjs/common';
import { MatchingService } from './matching.service';
import { MatchingController } from './matching.controller';
import { AuthModule } from '../auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmbeddingService } from './embedding.service';
import { UploadModule } from '../upload/upload.module';

@Module({
  imports: [AuthModule, ConfigModule, NotificationsModule, UploadModule],
  controllers: [MatchingController],
  providers: [MatchingService, EmbeddingService],
  exports: [MatchingService, EmbeddingService],
})
export class MatchingModule {}
