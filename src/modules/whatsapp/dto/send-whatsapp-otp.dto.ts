import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class SendWhatsappOtpDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message:
      'Phone number must be in international E.164 format, e.g. +27821234567',
  })
  phone!: string;
}