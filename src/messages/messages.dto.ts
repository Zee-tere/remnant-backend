import {
  IsInt,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Max,
  MinLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class StartConversationDto {
  @IsUUID()
  listingId: string;
}

export class CreateMessageDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  content: string;

  @IsIn(['TEXT', 'IMAGE', 'OFFER'])
  type: 'TEXT' | 'IMAGE' | 'OFFER' = 'TEXT';

  @IsOptional()
  @IsUUID()
  clientMessageId?: string;
}

export class GetConversationsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;
}

export class GetMessagesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterSequence?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  beforeSequence?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class MarkConversationReadDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  lastReadSequence?: number;

  @IsOptional()
  @IsUUID()
  lastReadMessageId?: string;
}

export class StartGuestConversationDto extends StartConversationDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(180)
  contact: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  offer: string;
}
