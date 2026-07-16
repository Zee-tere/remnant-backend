import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sign, verify, type JwtPayload } from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';

export type GuestAccessScope = 'conversation' | 'transaction';

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

  async getOrCreateGuestUser(name: string, emailAddress: string) {
    const email = emailAddress.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });

    if (
      existing?.emailVerified ||
      existing?.googleId ||
      existing?.passwordHash
    ) {
      throw new ConflictException(
        'An account already uses this email. Please log in to continue.',
      );
    }

    if (existing) {
      if (existing.name !== name.trim()) {
        return this.prisma.user.update({
          where: { id: existing.id },
          data: { name: name.trim() },
        });
      }
      return existing;
    }

    return this.prisma.user.create({
      data: {
        email,
        name: name.trim(),
        emailVerified: false,
      },
    });
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
      expiresIn: scope === 'transaction' ? '90d' : '30d',
    });
  }

  verifyToken(
    token: string | undefined,
    scope: GuestAccessScope,
    resourceId: string,
  ) {
    if (!token)
      throw new UnauthorizedException('Guest access token is required');

    try {
      const payload = verify(token, this.getSecret(), {
        algorithms: ['HS256'],
        issuer: 'remnant-api',
        audience: 'remnant-guest-access',
      }) as GuestAccessClaims;

      if (
        payload.scope !== scope ||
        payload.resourceId !== resourceId ||
        !payload.sub
      ) {
        throw new Error('Guest token scope mismatch');
      }
      return { userId: payload.sub, email: payload.email };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new UnauthorizedException('Guest access has expired or is invalid');
    }
  }

  private getSecret() {
    const secret = this.configService.get<string>('GUEST_ACCESS_SECRET') ?? '';
    if (secret.length < 32) {
      throw new ServiceUnavailableException(
        'Guest checkout and messaging are not configured yet.',
      );
    }
    return secret;
  }
}
