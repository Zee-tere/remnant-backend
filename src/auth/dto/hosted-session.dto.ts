import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

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

  @IsNotEmpty()
  @IsString()
  @MaxLength(256)
  nonce: string;
}
