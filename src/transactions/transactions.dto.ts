import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

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
