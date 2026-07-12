import { Module } from '@nestjs/common';
import { AchievementsService } from './achievements.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  providers: [AchievementsService, PrismaService],
  exports: [AchievementsService],
})
export class AchievementsModule {}
