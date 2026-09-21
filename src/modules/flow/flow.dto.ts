import { IsEmail, IsISO8601, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class FlowAccessBodyDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  accessKey?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  code?: string;
}

export class CreateFlowAccessKeyDto {
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  label!: string;

  @IsOptional()
  @IsIn(['read', 'write', 'full'])
  permission?: string;
}

export class FlowAllowedEmailDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;
}
