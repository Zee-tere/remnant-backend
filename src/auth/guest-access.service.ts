import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sign, verify, type JwtPayload } from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

export type GuestAccessScope = 'identity' | 'conversation' | 'transaction';

interface GuestAccessClaims extends JwtPayload {
  sub: string;
  scope: GuestAccessScope;
  resourceId: string;
  email: string;
}

@Injectable()
export class GuestAccessService {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  isConfigured() {
    return (
      (this.configService.get<string>('GUEST_ACCESS_SECRET') ?? '').length >= 32
    );
  }

  assertConfigured() {
    this.getSecret();
  }

  // Retained for historical, unregistered transaction code. Public marketplace
  // routes never call this path while payments are disabled.
  async getOrCreateGuestUser(name: string, emailAddress: string) {
    const email = emailAddress.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing?.emailVerified || existing?.googleId || existing?.passwordHash) {
      throw new ConflictException('An account already uses this email.');
    }
    if (existing) return existing;
    return this.prisma.user.create({
      data: { email, name: name.trim(), emailVerified: false },
    });
  }

  async getOrCreateGuestContactUser(name: string, _contactAddress: string) {
    return this.prisma.user.create({
      data: {
        email: `guest-${randomUUID()}@guest.remnant.local`,
        name: name.trim(),
        emailVerified: false,
      },
    });
  }

  async createGuestSession(name = 'Guest') {
    const user = await this.getOrCreateGuestContactUser(name, randomUUID());
    return {
      token: this.issueToken('identity', user.id, user),
      expiresInDays: 90,
    };
  }

  issueToken(
    scope: GuestAccessScope,
    resourceId: string,
    user: { id: string; email: string },
  ) {
    const secret = this.getSecret();
    return sign({ scope, resourceId, email: user.email }, secret, {
      algorithm: 'HS256',
      subject: user.id,
      issuer: 'remnant-api',
      audience: 'remnant-guest-access',
      expiresIn: scope === 'conversation' ? '30d' : '90d',
    });
  }

  verifyIdentityToken(token: string | undefined) {
    const payload = this.verifyPayload(token);
    if (payload.scope !== 'identity' || payload.resourceId !== payload.sub) {
      throw new UnauthorizedException('Guest access has expired or is invalid');
    }
    return { userId: payload.sub, email: payload.email };
  }

  verifyToken(
    token: string | undefined,
    scope: GuestAccessScope,
    resourceId: string,
  ) {
    const payload = this.verifyPayload(token);

    if (payload.scope !== scope || payload.resourceId !== resourceId) {
      throw new UnauthorizedException('Guest access has expired or is invalid');
    }
    return { userId: payload.sub, email: payload.email };
  }

  private verifyPayload(token: string | undefined) {
    if (!token) throw new UnauthorizedException('Guest access token is required');
    try {
      const payload = verify(token, this.getSecret(), {
        algorithms: ['HS256'],
        issuer: 'remnant-api',
        audience: 'remnant-guest-access',
      }) as GuestAccessClaims;
      if (!payload.sub || !payload.resourceId || !payload.scope) throw new Error('Invalid guest token');
      return payload;
    } catch (error) {
      if (error instanceof ServiceUnavailableException || error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Guest access has expired or is invalid');
    }
  }

  private getSecret() {
    const secret = this.configService.get<string>('GUEST_ACCESS_SECRET') ?? '';
    if (secret.length < 32) {
      throw new ServiceUnavailableException(
        'Guest messaging is temporarily unavailable. Please try again shortly.',
      );
    }
    return secret;
  }
}
