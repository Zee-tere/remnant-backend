import { IsEnum, IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';
import { ReportTarget } from '@prisma/client';

export class CreateReportDto {
  @IsEnum(ReportTarget)
  targetType: ReportTarget;

  @IsUUID()
  targetId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;
}
