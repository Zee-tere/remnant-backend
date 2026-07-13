import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { ConfigModule } from '@nestjs/config';
import { CognitoAuthService } from './cognito-auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Module({
  imports: [ConfigModule],
  controllers: [AuthController],
  providers: [AuthService, CognitoAuthService, JwtAuthGuard],
  exports: [AuthService, CognitoAuthService, JwtAuthGuard],
})
export class AuthModule {}
