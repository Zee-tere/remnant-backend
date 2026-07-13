import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class HostedSessionDto {
  @IsNotEmpty()
  @IsString()
  accessToken: string;

  @IsNotEmpty()
  @IsString()
  idToken: string;

  @IsOptional()
  @IsString()
  refreshToken?: string;
}
