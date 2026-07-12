import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsDecimal,
  IsArray,
  IsObject,
} from 'class-validator';
import { IntentionTag, Condition } from '@prisma/client';

export class CreateListingDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsString()
  @IsNotEmpty()
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

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsArray()
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
  city?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];
}
