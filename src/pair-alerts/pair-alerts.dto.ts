import { IsEnum, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { PairAlertStatus } from '@prisma/client';
import { LISTING_CATEGORIES } from '../config/listing-taxonomy';
import { NIGERIAN_STATES } from '../config/nigeria-locations';

export class CreatePairAlertDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  query: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsString()
  @IsIn(LISTING_CATEGORIES)
  category: string;

  @IsOptional()
  @IsString()
  @IsIn(NIGERIAN_STATES)
  city?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+(?:\.\d{1,2})?$/, { message: 'Budget must be a valid amount' })
  budget?: string;

  @IsOptional()
  @IsObject()
  compatibilityAttributes?: Record<string, unknown>;
}

export class UpdatePairAlertDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  query?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @IsIn(LISTING_CATEGORIES)
  category?: string;

  @IsOptional()
  @IsString()
  @IsIn(NIGERIAN_STATES)
  city?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+(?:\.\d{1,2})?$/, { message: 'Budget must be a valid amount' })
  budget?: string;

  @IsOptional()
  @IsObject()
  compatibilityAttributes?: Record<string, unknown>;

  @IsOptional()
  @IsEnum(PairAlertStatus)
  status?: PairAlertStatus;
}

export class UpdatePairAlertMatchDto {
  @IsIn(['VIEWED', 'DISMISSED'])
  status: 'VIEWED' | 'DISMISSED';
}
