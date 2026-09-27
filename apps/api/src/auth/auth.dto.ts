import { IsString, Length, Matches } from 'class-validator';

export class RequestOtpDto {
  @IsString()
  @Length(10, 20)
  phone!: string;
}

export class VerifyOtpDto {
  @IsString()
  @Length(10, 20)
  phone!: string;

  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code from the SMS.' })
  otp!: string;
}
