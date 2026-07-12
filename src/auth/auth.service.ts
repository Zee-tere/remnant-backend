import {
  Injectable,
  GoneException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CognitoIdentityProviderClient,
  GetUserCommand,
  InitiateAuthCommand,
  ConfirmSignUpCommand,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from './auth.types';
import { ConfirmSignupDto } from './dto/confirm-signup.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

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
  private readonly cognitoClient: CognitoIdentityProviderClient;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.cognitoClient = new CognitoIdentityProviderClient({
      region: this.configService.get<string>('AWS_REGION') ?? 'us-east-1',
    });
  }

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

  async register(dto: RegisterDto) {
    const clientId = this.getCognitoClientId();
    const email = this.normalizeEmail(dto.email);
    const name = dto.name.trim();

    try {
      const result = await this.cognitoClient.send(
        new SignUpCommand({
          ClientId: clientId,
          Username: email,
          Password: dto.password,
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'name', Value: name },
          ],
        }),
      );

      if (result.UserConfirmed) {
        return this.login({ email, password: dto.password });
      }

      return {
        requiresConfirmation: true,
        message: 'Check your email for the confirmation code.',
      };
    } catch (error) {
      throw this.toAuthException(error, 'Account could not be created.');
    }
  }

  async login(dto: LoginDto) {
    const clientId = this.getCognitoClientId();
    const email = this.normalizeEmail(dto.email);

    try {
      const result = await this.cognitoClient.send(
        new InitiateAuthCommand({
          ClientId: clientId,
          AuthFlow: 'USER_PASSWORD_AUTH',
          AuthParameters: {
            USERNAME: email,
            PASSWORD: dto.password,
          },
        }),
      );

      const accessToken = result.AuthenticationResult?.AccessToken;
      if (!accessToken) throw new UnauthorizedException('Login could not be completed.');

      const user = await this.syncUserFromAccessToken(accessToken);

      return {
        user,
        accessToken,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw this.toAuthException(error, 'Email or password is not correct.');
    }
  }

  async confirmSignup(dto: ConfirmSignupDto) {
    const clientId = this.getCognitoClientId();
    const email = this.normalizeEmail(dto.email);

    try {
      await this.cognitoClient.send(
        new ConfirmSignUpCommand({
          ClientId: clientId,
          Username: email,
          ConfirmationCode: dto.code.trim(),
        }),
      );

      return { message: 'Email confirmed. You can log in now.' };
    } catch (error) {
      throw this.toAuthException(error, 'Confirmation code could not be verified.');
    }
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: SAFE_USER_SELECT,
    });

    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  private async syncUserFromAccessToken(accessToken: string) {
    const userInfo = await this.cognitoClient.send(new GetUserCommand({ AccessToken: accessToken }));
    const attributes = new Map((userInfo.UserAttributes ?? []).map((item) => [item.Name, item.Value]));
    const cognitoSub = attributes.get('sub');
    const email = this.normalizeEmail(attributes.get('email'));
    const name = attributes.get('name')?.trim() || (email ? email.split('@')[0] : 'Remnant user');
    const emailVerified = attributes.get('email_verified') === 'true';

    if (!cognitoSub || !email) {
      throw new UnauthorizedException('Login could not be completed.');
    }

    await this.prisma.user.upsert({
      where: { id: cognitoSub },
      create: {
        id: cognitoSub,
        email,
        name,
        emailVerified,
      },
      update: {
        email,
        name,
        emailVerified,
      },
    });

    return this.getProfile(cognitoSub);
  }

  private getCognitoClientId() {
    const clientId = this.configService.get<string>('COGNITO_CLIENT_ID');
    if (!clientId) throw new InternalServerErrorException('Sign-in is not configured.');
    return clientId;
  }

  private normalizeEmail(email?: string) {
    const normalized = email?.trim().toLowerCase();
    if (!normalized) throw new BadRequestException('A valid email address is required.');
    return normalized;
  }

  private toAuthException(error: unknown, fallback: string) {
    const maybeError = error as { name?: string; message?: string };
    const rawMessage = maybeError.message ?? '';

    if (/SECRET_HASH|client secret|invalid client/i.test(rawMessage)) {
      return new InternalServerErrorException(
        'Authentication is pointing at a Cognito app client with a secret. Use the public web app client id in Lambda.',
      );
    }

    if (maybeError.name === 'UsernameExistsException') {
      return new BadRequestException('An account already exists for this email.');
    }

    if (maybeError.name === 'UserNotConfirmedException') {
      return new BadRequestException('Please confirm your email before logging in.');
    }

    if (maybeError.name === 'NotAuthorizedException' || maybeError.name === 'UserNotFoundException') {
      return new UnauthorizedException(fallback);
    }

    if (maybeError.name === 'InvalidPasswordException' || maybeError.name === 'InvalidParameterException') {
      return new BadRequestException(rawMessage || fallback);
    }

    return new BadRequestException(fallback);
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
