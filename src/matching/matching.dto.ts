import { IsIn } from 'class-validator';

export class UpdateMatchStatusDto {
  @IsIn(['VIEWED', 'DISMISSED'])
  status: 'VIEWED' | 'DISMISSED';
}
