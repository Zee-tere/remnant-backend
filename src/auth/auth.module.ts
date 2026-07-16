import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { ConfigModule } from '@nestjs/config';
import { CognitoAuthService } from './cognito-auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { GuestAccessService } from './guest-access.service';

@Module({
  imports: [ConfigModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    CognitoAuthService,
    JwtAuthGuard,
    GuestAccessService,
  ],
  exports: [AuthService, CognitoAuthService, JwtAuthGuard, GuestAccessService],
})
export class AuthModule {}
