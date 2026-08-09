import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';
import { NIGERIAN_STATES } from '../config/nigeria-locations';

export class UpdateUserDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  bio?: string;

  @IsOptional()
  @IsString()
  @IsIn(NIGERIAN_STATES)
  city?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(1000)
  avatarUrl?: string;

  @IsOptional()
  @IsBoolean()
  isPublicProfile?: boolean;

  @IsOptional()
  @IsBoolean()
  showStateOnProfile?: boolean;
}
