import { IsDateString, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { ListingStatus, TransactionStatus, UserRole } from '@prisma/client';

export enum AdminReportAction {
  DISMISS = 'DISMISS',
  FLAG_LISTING = 'FLAG_LISTING',
  REMOVE_LISTING = 'REMOVE_LISTING',
  BAN_USER = 'BAN_USER',
}

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

export class AdminReportActionDto {
  @IsEnum(AdminReportAction)
  action: AdminReportAction;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  resolution?: string;
}

export class AdminMessageUserDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  message: string;
}
