import { Injectable, GoneException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from './auth.types';

const SAFE_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  avatarUrl: true,
  bio: true,
  city: true,
  role: true,
  trustTier: true,
  points: true,
  emailVerified: true,
  createdAt: true,
  updatedAt: true,
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  cognitoOnly(): never {
    throw new GoneException({
      message: 'Backend-issued auth has been replaced by Cognito Hosted UI.',
      hostedUiDomain: this.configService.get<string>('COGNITO_HOSTED_UI_DOMAIN') ?? null,
      clientId: this.configService.get<string>('COGNITO_CLIENT_ID') ?? null,
    });
  }

  getAuthConfig() {
    return {
      userPoolId: this.configService.get<string>('COGNITO_USER_POOL_ID') ?? null,
      clientId: this.configService.get<string>('COGNITO_CLIENT_ID') ?? null,
      hostedUiDomain: this.configService.get<string>('COGNITO_HOSTED_UI_DOMAIN') ?? null,
      frontendUrl: this.configService.get<string>('FRONTEND_URL') ?? null,
      supabaseUrl: this.configService.get<string>('SUPABASE_URL') ?? null,
    };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: SAFE_USER_SELECT,
    });

    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  createSupabaseRealtimeToken(user: AuthenticatedUser) {
    const secret = this.configService.get<string>('SUPABASE_JWT_SECRET');
    if (!secret) {
      throw new InternalServerErrorException('SUPABASE_JWT_SECRET is not configured');
    }

    const expiresIn = this.configService.get<string>('SUPABASE_JWT_EXPIRES_IN', '15m');
    const accessToken = jwt.sign(
      {
        sub: user.userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: user.email,
        cognito_sub: user.cognitoSub,
      },
      secret,
      { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] },
    );

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn,
    };
  }
}
