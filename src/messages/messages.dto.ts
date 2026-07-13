import { IsIn, IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

export class StartConversationDto {
  @IsUUID()
  listingId: string;
}

export class CreateMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  content: string;

  @IsIn(['TEXT', 'IMAGE', 'OFFER'])
  type: 'TEXT' | 'IMAGE' | 'OFFER' = 'TEXT';
}
