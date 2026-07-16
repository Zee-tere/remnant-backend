import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class InitiateTransactionDto {
  @IsUUID()
  listingId: string;
}

export class MarkShippedDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  trackingInfo?: string;
}

export class InitiateGuestTransactionDto extends InitiateTransactionDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @IsEmail()
  @MaxLength(254)
  email: string;
}
