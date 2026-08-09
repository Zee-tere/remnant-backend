import { IsOptional, IsString, MaxLength } from 'class-validator';

export class LogoutDto {
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  accessToken?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8192)
  refreshToken?: string;
}
