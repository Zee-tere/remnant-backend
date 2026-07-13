import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { ConfirmSignupDto } from './dto/confirm-signup.dto';
import { HostedSessionDto } from './dto/hosted-session.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/forgot-password.dto';
import { HostedCodeDto } from './dto/hosted-code.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('config')
  getAuthConfig() {
    return this.authService.getAuthConfig();
  }

  @Post('register')
  @Throttle({ auth: { limit: 5, ttl: 60000 } })
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  @Throttle({ auth: { limit: 10, ttl: 60000 } })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('confirm-signup')
  @Throttle({ auth: { limit: 10, ttl: 60000 } })
  confirmSignup(@Body() dto: ConfirmSignupDto) {
    return this.authService.confirmSignup(dto);
  }

  @Post('hosted-session')
  @Throttle({ auth: { limit: 10, ttl: 60000 } })
  hostedSession(@Body() dto: HostedSessionDto) {
    return this.authService.hostedSession(dto);
  }

  @Post('exchange-code')
  @Throttle({ auth: { limit: 10, ttl: 60000 } })
  exchangeHostedCode(@Body() dto: HostedCodeDto) {
    return this.authService.exchangeHostedCode(dto);
  }

  @Post('refresh')
  @Throttle({ auth: { limit: 10, ttl: 60000 } })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Get('google')
  googleAuth() {
    return this.authService.cognitoOnly();
  }

  @Get('google/callback')
  googleAuthRedirect() {
    return this.authService.cognitoOnly();
  }

  @Post('forgot-password')
  @Throttle({ auth: { limit: 3, ttl: 60000 } })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Post('reset-password')
  @Throttle({ auth: { limit: 5, ttl: 60000 } })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.email, dto.code, dto.password);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  getCurrentUser(@Req() req: Request) {
    return this.authService.getProfile(req.user!.userId);
  }

  @Post('supabase-token')
  @UseGuards(JwtAuthGuard)
  createSupabaseToken(@Req() req: Request) {
    return this.authService.createSupabaseRealtimeToken(req.user!);
  }
}
