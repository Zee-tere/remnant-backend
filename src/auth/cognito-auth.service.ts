import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CognitoIdentityProviderClient, GetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
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
  private readonly cognitoClient: CognitoIdentityProviderClient;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.cognitoClient = new CognitoIdentityProviderClient({
      region: this.configService.get<string>('AWS_REGION') ?? 'us-east-1',
    });
  }

  async verifyBearerToken(token: string): Promise<AuthenticatedUser> {
    try {
      const payload = (await this.getVerifier().verify(token)) as CognitoPayload;
      return this.ensureLocalUser(payload, token);
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
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

  private async ensureLocalUser(payload: CognitoPayload, accessToken: string): Promise<AuthenticatedUser> {
    const cognitoSub = payload.sub;
    let user = await this.prisma.user.findUnique({ where: { id: cognitoSub } });
    if (!user) user = await this.prisma.user.findUnique({ where: { googleId: cognitoSub } });

    if (user) return this.toAuthenticatedUser(user, cognitoSub, payload.username ?? payload['cognito:username']);

    const attributes = await this.getUserAttributes(accessToken);
    const email = this.normalizeEmail(payload.email ?? attributes.get('email'));
    const username = payload.username ?? payload['cognito:username'] ?? attributes.get('username');
    const name =
      payload.name ??
      attributes.get('name') ??
      attributes.get('given_name') ??
      (email ? email.split('@')[0] : undefined);

    if (!email) {
      throw new UnauthorizedException(
        'Your sign-in provider did not share an email address. Please check the Cognito email/profile scopes and Google attribute mapping.',
      );
    }

    if (!user) user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          id: cognitoSub,
          email,
          name: name ?? 'Remnant user',
          emailVerified: true,
          googleId: username?.startsWith('google_') ? cognitoSub : undefined,
        },
      });
    } else {
      const updates: { email?: string; name?: string; emailVerified?: boolean; googleId?: string } = {};

      if (user.email.endsWith('@cognito.remnant.local') || user.email !== email) {
        updates.email = email;
        updates.emailVerified = true;
      }

      if (name && user.name !== name) {
        updates.name = name;
      }

      if (username?.startsWith('google_') && user.googleId !== cognitoSub) {
        updates.googleId = cognitoSub;
      }

      if (Object.keys(updates).length) {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: updates,
        });
      }
    }

    return this.toAuthenticatedUser(user, cognitoSub, username);
  }

  private toAuthenticatedUser(
    user: { id: string; email: string; name: string; role: string; bannedAt?: Date | null },
    cognitoSub: string,
    username?: string,
  ): AuthenticatedUser {
    if (user.bannedAt) throw new UnauthorizedException('This account is suspended.');
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

  private async getUserAttributes(accessToken: string) {
    const attributes = new Map<string, string>();

    try {
      const result = await this.cognitoClient.send(new GetUserCommand({ AccessToken: accessToken }));
      if (result.Username) attributes.set('username', result.Username);
      for (const item of result.UserAttributes ?? []) {
        if (item.Name && item.Value) attributes.set(item.Name, item.Value);
      }
    } catch {
      return attributes;
    }

    return attributes;
  }

  private normalizeEmail(email?: string) {
    const normalized = email?.trim().toLowerCase();
    return normalized || undefined;
  }
}
