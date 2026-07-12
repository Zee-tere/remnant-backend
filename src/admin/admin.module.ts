import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { TransactionsModule } from '../transactions/transactions.module';

@Module({
  imports: [AuthModule, ConfigModule, TransactionsModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, PrismaService],
})
export class AdminModule {}
