import {
  IsIn,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class StartConversationDto {
  @IsUUID()
  listingId: string;
}

export class CreateMessageDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  content: string;

  @IsIn(['TEXT', 'IMAGE', 'OFFER'])
  type: 'TEXT' | 'IMAGE' | 'OFFER' = 'TEXT';
}

export class StartGuestConversationDto extends StartConversationDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(180)
  contact: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  offer: string;
}
