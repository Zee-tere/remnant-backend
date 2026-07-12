import { Module } from '@nestjs/common';
import { MatchingService } from './matching.service';
import { MatchingController } from './matching.controller';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmbeddingService } from './embedding.service';

@Module({
  imports: [AuthModule, ConfigModule, NotificationsModule],
  controllers: [MatchingController],
  providers: [MatchingService, EmbeddingService, PrismaService],
  exports: [MatchingService, EmbeddingService],
})
export class MatchingModule {}
