import { Body, Controller, Get, Post, Req, Res, UseGuards, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { ConfirmSignupDto } from './dto/confirm-signup.dto';
import { HostedSessionDto } from './dto/hosted-session.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/forgot-password.dto';
import { HostedCodeDto } from './dto/hosted-code.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { GuestAccessService } from './guest-access.service';
import { GuestSessionDto } from './dto/guest-session.dto';
import { LogoutDto } from './dto/logout.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly guestAccessService: GuestAccessService,
  ) {}

  @Get('config')
  getAuthConfig() {
    return this.authService.getAuthConfig();
  }

  @Post('register')
  @Throttle({ auth: { limit: 5, ttl: 60000 } })
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.authService.register(dto);
    return this.withRefreshCookie(response, result);
  }

  @Post('guest-session')
  @Throttle({ auth: { limit: 4, ttl: 60000 } })
  createGuestSession(@Body() dto: GuestSessionDto) {
    return this.guestAccessService.createGuestSession(dto.name);
  }

  @Post('login')
  @Throttle({ auth: { limit: 10, ttl: 60000 } })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) response: Response) {
    return this.withRefreshCookie(response, await this.authService.login(dto));
  }

  @Post('confirm-signup')
  @Throttle({ auth: { limit: 10, ttl: 60000 } })
  confirmSignup(@Body() dto: ConfirmSignupDto) {
    return this.authService.confirmSignup(dto);
  }

  @Post('hosted-session')
  @Throttle({ auth: { limit: 10, ttl: 60000 } })
  async hostedSession(@Body() dto: HostedSessionDto, @Res({ passthrough: true }) response: Response) {
    return this.withRefreshCookie(response, await this.authService.hostedSession(dto));
  }

  @Post('exchange-code')
  @Throttle({ auth: { limit: 10, ttl: 60000 } })
  async exchangeHostedCode(@Body() dto: HostedCodeDto, @Res({ passthrough: true }) response: Response) {
    return this.withRefreshCookie(response, await this.authService.exchangeHostedCode(dto));
  }

  @Post('refresh')
  @Throttle({ auth: { limit: 10, ttl: 60000 } })
  async refresh(@Body() dto: RefreshTokenDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const refreshToken = dto.refreshToken ?? this.readCookie(request, 'remnant_refresh');
    if (!refreshToken) throw new UnauthorizedException('Your session has expired. Please log in again.');
    return this.withRefreshCookie(response, await this.authService.refresh(refreshToken));
  }

  @Post('logout')
  @Throttle({ auth: { limit: 10, ttl: 60000 } })
  async logout(@Body() dto: LogoutDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const refreshToken = dto.refreshToken ?? this.readCookie(request, 'remnant_refresh');
    response.clearCookie('remnant_refresh', this.refreshCookieBaseOptions());
    return this.authService.logout(dto.accessToken, refreshToken);
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

  private withRefreshCookie<T extends Record<string, unknown>>(response: Response, result: T) {
    const refreshToken = typeof result.refreshToken === 'string' ? result.refreshToken : undefined;
    if (refreshToken) response.cookie('remnant_refresh', refreshToken, this.refreshCookieOptions());
    const { refreshToken: _refreshToken, ...publicResult } = result;
    return publicResult;
  }

  private refreshCookieOptions() {
    return {
      ...this.refreshCookieBaseOptions(),
      maxAge: 30 * 24 * 60 * 60 * 1000,
    };
  }

  private refreshCookieBaseOptions() {
    const production = process.env.NODE_ENV === 'production' || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
    return {
      httpOnly: true,
      secure: production,
      sameSite: production ? 'none' as const : 'lax' as const,
      path: '/auth',
    };
  }

  private readCookie(request: Request, name: string) {
    for (const item of (request.headers.cookie ?? '').split(';')) {
      const separator = item.indexOf('=');
      if (separator < 0) continue;
      if (item.slice(0, separator).trim() === name) return decodeURIComponent(item.slice(separator + 1).trim());
    }
    return undefined;
  }
}
