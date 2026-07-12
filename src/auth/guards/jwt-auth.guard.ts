import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { CognitoAuthService } from '../cognito-auth.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly cognitoAuthService: CognitoAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('No token provided');
    }

    const token = authHeader.split(' ')[1];
    request.user = await this.cognitoAuthService.verifyBearerToken(token);
    return true;
  }
}
