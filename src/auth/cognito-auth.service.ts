import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from './auth.types';

type CognitoPayload = {
  sub: string;
  email?: string;
  name?: string;
  username?: string;
  'cognito:username'?: string;
};

@Injectable()
export class CognitoAuthService {
  private verifier?: ReturnType<typeof CognitoJwtVerifier.create>;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async verifyBearerToken(token: string): Promise<AuthenticatedUser> {
    try {
      const payload = (await this.getVerifier().verify(token)) as CognitoPayload;
      return this.ensureLocalUser(payload);
    } catch {
      throw new UnauthorizedException('Invalid or expired Cognito token');
    }
  }

  private getVerifier() {
    if (this.verifier) return this.verifier;

    const userPoolId = this.configService.get<string>('COGNITO_USER_POOL_ID');
    const clientId = this.configService.get<string>('COGNITO_CLIENT_ID');

    if (!userPoolId || !clientId) {
      throw new UnauthorizedException('Cognito authentication is not configured');
    }

    this.verifier = CognitoJwtVerifier.create({
      userPoolId,
      tokenUse: 'access',
      clientId,
    });

    return this.verifier;
  }

  private async ensureLocalUser(payload: CognitoPayload): Promise<AuthenticatedUser> {
    const cognitoSub = payload.sub;
    const email = this.normalizeEmail(payload.email);
    const username = payload.username ?? payload['cognito:username'];
    const name = payload.name ?? (email ? email.split('@')[0] : username) ?? 'Remnant user';

    let user = await this.prisma.user.findUnique({ where: { id: cognitoSub } });

    if (!user && email) {
      user = await this.prisma.user.findUnique({ where: { email } });
    }

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          id: cognitoSub,
          email: email ?? `${cognitoSub}@cognito.remnant.local`,
          name,
          emailVerified: Boolean(email),
        },
      });
    } else {
      const updates: { email?: string; name?: string; emailVerified?: boolean } = {};

      if (email && user.email !== email) {
        updates.email = email;
        updates.emailVerified = true;
      }

      if (name && user.name !== name) {
        updates.name = name;
      }

      if (Object.keys(updates).length) {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: updates,
        });
      }
    }

    return {
      sub: user.id,
      userId: user.id,
      cognitoSub,
      email: user.email,
      name: user.name,
      username,
      role: user.role,
    };
  }

  private normalizeEmail(email?: string) {
    const normalized = email?.trim().toLowerCase();
    return normalized || undefined;
  }
}
