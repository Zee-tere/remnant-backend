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
  ArrayMaxSize,
  IsUrl,
  IsEmail,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
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

export class GuestContactDto {
  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9 ()-]{7,24}$/, {
    message: 'Phone number may only contain digits, spaces, brackets, hyphens, and an optional leading +',
  })
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(120)
  telegram?: string;
}

export class CreateGuestListingDto extends CreateListingDto {
  @IsObject()
  @ValidateNested()
  @Type(() => GuestContactDto)
  guestContact: GuestContactDto;
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
