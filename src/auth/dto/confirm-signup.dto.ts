import { IsEmail, IsNotEmpty, IsString, Length } from 'class-validator';

export class ConfirmSignupDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  @Length(4, 12)
  code: string;
}
