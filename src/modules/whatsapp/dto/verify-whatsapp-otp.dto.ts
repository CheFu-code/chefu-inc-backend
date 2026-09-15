import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';

export class VerifyWhatsappOtpDto {
    @IsString()
    @IsNotEmpty()
    @Matches(/^\+[1-9]\d{7,14}$/, {
        message:
            'Phone number must be in international E.164 format',
    })
    phone!: string;

    @IsString()
    @Length(6, 6)
    @Matches(/^\d{6}$/, {
        message: 'OTP must contain exactly 6 digits',
    })
    code!: string;
}