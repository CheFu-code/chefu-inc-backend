import { IsString, Length, Matches } from 'class-validator';

export class SendCodeDto {
    // Accepts "082 123 4567" or "+27821234567". The service normalises it.
    @IsString()
    @Length(7, 32)
    @Matches(/^\+?[\d\s()-]+$/)
    phone!: string;
}

export class CheckCodeDto extends SendCodeDto {
    @IsString()
    @Length(4, 10)
    @Matches(/^\d{4,10}$/)
    code!: string;
}
