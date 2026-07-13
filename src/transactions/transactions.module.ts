import { Module } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { EscrowService } from './escrow.service';
import { AuthModule } from '../auth/auth.module';
import { ConfigModule } from '@nestjs/config';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [AuthModule, ConfigModule, NotificationsModule],
  controllers: [TransactionsController],
  providers: [TransactionsService, EscrowService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
