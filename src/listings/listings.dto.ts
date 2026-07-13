import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsDecimal,
  IsArray,
  IsObject,
  IsIn,
  MaxLength,
  MinLength,
  ArrayMaxSize,
  IsUrl,
} from 'class-validator';
import { IntentionTag, Condition } from '@prisma/client';
import { NIGERIAN_STATES } from '../config/nigeria-locations';
import { LISTING_CATEGORIES } from '../config/listing-taxonomy';

export class CreateListingDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(2000)
  description: string;

  @IsString()
  @IsNotEmpty()
  @IsIn(LISTING_CATEGORIES)
  category: string;

  @IsEnum(Condition)
  condition: Condition;

  @IsEnum(IntentionTag)
  intentionTag: IntentionTag;

  @IsOptional()
  @IsString()
  pairingKeyword?: string;

  @IsOptional()
  @IsObject()
  compatibilityAttributes?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  price?: string;

  @IsString()
  @IsIn(NIGERIAN_STATES)
  city: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsUrl({ require_protocol: true }, { each: true })
  @IsString({ each: true })
  images?: string[];
}

export class UpdateListingDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @IsIn(LISTING_CATEGORIES)
  category?: string;

  @IsOptional()
  @IsEnum(Condition)
  condition?: Condition;

  @IsOptional()
  @IsEnum(IntentionTag)
  intentionTag?: IntentionTag;

  @IsOptional()
  @IsString()
  pairingKeyword?: string;

  @IsOptional()
  @IsObject()
  compatibilityAttributes?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  price?: string;

  @IsOptional()
  @IsString()
  @IsIn(NIGERIAN_STATES)
  city?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsUrl({ require_protocol: true }, { each: true })
  @IsString({ each: true })
  images?: string[];
}
