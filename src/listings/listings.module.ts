import { Module } from '@nestjs/common';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { MatchingModule } from '../matching/matching.module';

@Module({
  imports: [AuthModule, MatchingModule],
  controllers: [ListingsController],
  providers: [ListingsService, PrismaService],
  exports: [ListingsService],
})
export class ListingsModule {}
