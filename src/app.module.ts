import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { UserModule } from './user/user.module';
import { ListingsModule } from './listings/listings.module';
import { UploadModule } from './upload/upload.module';
import { MessagesModule } from './messages/messages.module';
import { MatchingModule } from './matching/matching.module';
import { NotificationsModule } from './notifications/notifications.module';
import { TransactionsModule } from './transactions/transactions.module';
import { ReviewsModule } from './reviews/reviews.module';
import { AchievementsModule } from './achievements/achievements.module';
import { AdminModule } from './admin/admin.module';
import { ReportsModule } from './reports/reports.module';
import { PairAlertsModule } from './pair-alerts/pair-alerts.module';
import { validateEnvironment } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    PrismaModule,
    // ✅ Global rate limiting: 100 requests per minute per IP by default
    // Auth routes apply stricter limits via @Throttle() decorator
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60000,   // 1 minute window
        limit: 100,   // 100 requests per window
      },
      {
        name: 'auth',
        ttl: 60000,   // 1 minute window
        limit: 10,    // 10 requests per window for auth routes
      },
    ]),
    AuthModule,
    UserModule,
    ListingsModule,
    UploadModule,
    MessagesModule,
    MatchingModule,
    NotificationsModule,
    TransactionsModule,
    ReviewsModule,
    AchievementsModule,
    AdminModule,
    ReportsModule,
    PairAlertsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // ✅ Apply ThrottlerGuard globally to all routes
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
