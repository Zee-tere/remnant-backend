import { IsDateString, IsEnum, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { ListingStatus, TransactionStatus, UserRole } from '@prisma/client';

export class AdminUpdateUserDto {
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsDateString()
  bannedAt?: string | null;
}

export class AdminListingStatusDto {
  @IsEnum(ListingStatus)
  status: ListingStatus;
}

export class AdminTransactionStatusDto {
  @IsEnum(TransactionStatus)
  status: TransactionStatus;
}

export class ResolveReportDto {
  @IsString()
  @MaxLength(1000)
  resolution: string;
}
