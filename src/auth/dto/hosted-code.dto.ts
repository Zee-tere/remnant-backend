import { IsNotEmpty, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

export class HostedCodeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  code: string;

  @IsString()
  @MinLength(43)
  @MaxLength(128)
  codeVerifier: string;

  @IsUrl({ require_protocol: true, protocols: ['https'] })
  redirectUri: string;
}
