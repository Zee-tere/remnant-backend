import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CognitoAuthService } from '../auth/cognito-auth.service';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly cognitoAuthService: CognitoAuthService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new ForbiddenException('Not authenticated');
    }

    const token = authHeader.split(' ')[1];
    try {
      const payload = await this.cognitoAuthService.verifyBearerToken(token);
      request.user = payload;

      const user = await this.prisma.user.findUnique({
        where: { id: payload.userId },
        select: { role: true },
      });

      if (!user || user.role !== 'ADMIN') {
        throw new ForbiddenException('Admin access required');
      }

      return true;
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      throw new ForbiddenException('Invalid token');
    }
  }
}
