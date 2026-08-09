import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsArray,
  IsObject,
  IsIn,
  MaxLength,
  ArrayMaxSize,
  ArrayMinSize,
  IsUrl,
  Matches,
  IsUUID,
  IsInt,
  Min,
  MinLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { IntentionTag, Condition, ListingStatus } from '@prisma/client';
import { NIGERIAN_STATES } from '../config/nigeria-locations';
import { LISTING_CATEGORIES } from '../config/listing-taxonomy';

export class CreateListingDto {
  @IsUUID()
  clientRequestId: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(120)
  title: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
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
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(160)
  pairingKeyword?: string;

  @IsOptional()
  @IsObject()
  compatibilityAttributes?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @Matches(/^(?!0+(?:\.0{1,2})?$)\d{1,9}(?:\.\d{1,2})?$/, {
    message: 'Price must be greater than zero and no more than 999,999,999.99',
  })
  price?: string;

  @IsString()
  @IsIn(NIGERIAN_STATES)
  city: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsUrl({ require_protocol: true }, { each: true })
  @IsString({ each: true })
  images: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsUUID(undefined, { each: true })
  uploadIds: string[];
}

export const GUEST_CONTACT_METHODS = ['WHATSAPP', 'EMAIL', 'TELEGRAM'] as const;
export type GuestContactMethod = (typeof GUEST_CONTACT_METHODS)[number];

export class CreateGuestListingDto extends CreateListingDto {
  @IsString()
  @IsIn(GUEST_CONTACT_METHODS)
  contactMethod: GuestContactMethod;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  contactValue: string;
}

export class UpdateGuestListingStatusDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;

  @IsString()
  @IsIn(['ACTIVE', 'PAUSED', 'COMPLETED'])
  status: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
}

export class UpdateGuestListingContactDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;

  @IsString()
  @IsIn(GUEST_CONTACT_METHODS)
  contactMethod: GuestContactMethod;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  contactValue: string;
}

export class UpdateListingDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
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
  @MaxLength(160)
  pairingKeyword?: string;

  @IsOptional()
  @IsObject()
  compatibilityAttributes?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @Matches(/^(?!0+(?:\.0{1,2})?$)\d{1,9}(?:\.\d{1,2})?$/, {
    message: 'Price must be greater than zero and no more than 999,999,999.99',
  })
  price?: string;

  @IsOptional()
  @IsString()
  @IsIn(NIGERIAN_STATES)
  city?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsUrl({ require_protocol: true }, { each: true })
  @IsString({ each: true })
  images?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsUUID(undefined, { each: true })
  uploadIds?: string[];

  @IsOptional()
  @IsEnum(ListingStatus)
  @IsIn(['ACTIVE', 'PAUSED', 'COMPLETED'])
  status?: 'ACTIVE' | 'PAUSED' | 'COMPLETED';
}
