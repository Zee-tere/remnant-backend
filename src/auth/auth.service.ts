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
  AdminInitiateAuthCommand,
  ConfirmSignUpCommand,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from './auth.types';
import { ConfirmSignupDto } from './dto/confirm-signup.dto';
import { HostedSessionDto } from './dto/hosted-session.dto';
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
  private idTokenVerifier?: ReturnType<typeof CognitoJwtVerifier.create>;
  private accessTokenVerifier?: ReturnType<typeof CognitoJwtVerifier.create>;

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
      let result;
      try {
        result = await this.cognitoClient.send(
          new InitiateAuthCommand({
            ClientId: clientId,
            AuthFlow: 'USER_PASSWORD_AUTH',
            AuthParameters: {
              USERNAME: email,
              PASSWORD: dto.password,
            },
          }),
        );
      } catch (error) {
        if (!this.isUserPasswordFlowDisabled(error)) throw error;
        result = await this.adminPasswordLogin(email, dto.password);
      }

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

  async hostedSession(dto: HostedSessionDto) {
    try {
      const idPayload = (await this.getIdTokenVerifier().verify(dto.idToken)) as {
        sub?: string;
        email?: string;
        name?: string;
        given_name?: string;
        family_name?: string;
        picture?: string;
        email_verified?: boolean | string;
        identities?: string;
        'cognito:username'?: string;
      };
      const accessPayload = (await this.getAccessTokenVerifier().verify(dto.accessToken)) as {
        sub?: string;
        username?: string;
        'cognito:username'?: string;
      };

      const cognitoSub = idPayload.sub ?? accessPayload.sub;
      if (!cognitoSub || accessPayload.sub !== cognitoSub) {
        throw new UnauthorizedException('Sign-in could not be verified. Please try again.');
      }

      if (!idPayload.email) {
        throw new UnauthorizedException(
          'Your sign-in provider did not share an email address. Please check the Cognito email/profile scopes and Google attribute mapping.',
        );
      }

      const email = this.normalizeEmail(idPayload.email);
      const name =
        idPayload.name?.trim() ||
        [idPayload.given_name, idPayload.family_name].filter(Boolean).join(' ').trim() ||
        email.split('@')[0];
      const username = idPayload['cognito:username'] ?? accessPayload['cognito:username'] ?? accessPayload.username;
      const emailVerified = idPayload.email_verified === true || idPayload.email_verified === 'true';
      const googleId = username?.startsWith('google_') ? cognitoSub : undefined;

      const existingByGoogleId = googleId ? await this.prisma.user.findUnique({ where: { googleId } }) : null;
      const existingBySub = await this.prisma.user.findUnique({ where: { id: cognitoSub } });
      const existingByEmail = await this.prisma.user.findUnique({ where: { email } });
      const existing = existingByGoogleId ?? existingBySub ?? existingByEmail;

      const user = existing
        ? await this.prisma.user.update({
            where: { id: existing.id },
            data: {
              email: !existingByEmail || existingByEmail.id === existing.id ? email : existing.email,
              name,
              emailVerified,
              avatarUrl: existing.avatarUrl ?? idPayload.picture,
              googleId: !existingByGoogleId || existingByGoogleId.id === existing.id ? googleId : existing.googleId,
            },
            select: SAFE_USER_SELECT,
          })
        : await this.prisma.user.create({
            data: {
              id: cognitoSub,
              email,
              name,
              emailVerified,
              avatarUrl: idPayload.picture,
              googleId,
            },
            select: SAFE_USER_SELECT,
          });

      return {
        user,
        accessToken: dto.accessToken,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException || error instanceof BadRequestException) throw error;
      console.error('[AuthService] Hosted session failed', error);
      throw new UnauthorizedException('Google sign-in could not be completed. Please try again.');
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

  private getCognitoUserPoolId() {
    const userPoolId = this.configService.get<string>('COGNITO_USER_POOL_ID');
    if (!userPoolId) throw new InternalServerErrorException('Sign-in is not configured.');
    return userPoolId;
  }

  private adminPasswordLogin(email: string, password: string) {
    return this.cognitoClient.send(
      new AdminInitiateAuthCommand({
        UserPoolId: this.getCognitoUserPoolId(),
        ClientId: this.getCognitoClientId(),
        AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
        },
      }),
    );
  }

  private isUserPasswordFlowDisabled(error: unknown) {
    const message = (error as { message?: string }).message ?? '';
    return /USER_PASSWORD_AUTH flow not enabled/i.test(message);
  }

  private getIdTokenVerifier() {
    if (this.idTokenVerifier) return this.idTokenVerifier;

    const userPoolId = this.getCognitoUserPoolId();
    const clientId = this.getCognitoClientId();

    this.idTokenVerifier = CognitoJwtVerifier.create({
      userPoolId,
      tokenUse: 'id',
      clientId,
    });

    return this.idTokenVerifier;
  }

  private getAccessTokenVerifier() {
    if (this.accessTokenVerifier) return this.accessTokenVerifier;

    const userPoolId = this.getCognitoUserPoolId();
    const clientId = this.getCognitoClientId();

    this.accessTokenVerifier = CognitoJwtVerifier.create({
      userPoolId,
      tokenUse: 'access',
      clientId,
    });

    return this.accessTokenVerifier;
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

    if (/USER_PASSWORD_AUTH flow not enabled/i.test(rawMessage)) {
      return new InternalServerErrorException(
        'Password login is not enabled for the current Cognito app client. Enable ALLOW_USER_PASSWORD_AUTH or ALLOW_ADMIN_USER_PASSWORD_AUTH on the public app client.',
      );
    }

    if (/ADMIN_USER_PASSWORD_AUTH flow not enabled/i.test(rawMessage)) {
      return new InternalServerErrorException(
        'Backend password login fallback is not enabled for the current Cognito app client. Enable ALLOW_ADMIN_USER_PASSWORD_AUTH or ALLOW_USER_PASSWORD_AUTH.',
      );
    }

    if (maybeError.name === 'AccessDeniedException' && /AdminInitiateAuth/i.test(rawMessage)) {
      return new InternalServerErrorException(
        'Lambda is not allowed to run Cognito AdminInitiateAuth. Add cognito-idp:AdminInitiateAuth to remnant-lambda-role or enable USER_PASSWORD_AUTH on the app client.',
      );
    }

    if (/Invalid FROM email address ARN/i.test(rawMessage)) {
      return new InternalServerErrorException(
        'Cognito email delivery is not configured correctly. Verify the SES sender identity or switch the user pool to Cognito default email.',
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
