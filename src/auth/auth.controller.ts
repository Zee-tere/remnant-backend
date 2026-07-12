import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { ConfirmSignupDto } from './dto/confirm-signup.dto';
import { HostedSessionDto } from './dto/hosted-session.dto';
import { LoginDto } from './dto/login.dto';
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

  @Post('refresh')
  @Throttle({ auth: { limit: 10, ttl: 60000 } })
  refresh() {
    return this.authService.cognitoOnly();
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
  forgotPassword() {
    return this.authService.cognitoOnly();
  }

  @Post('reset-password')
  @Throttle({ auth: { limit: 5, ttl: 60000 } })
  resetPassword() {
    return this.authService.cognitoOnly();
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
