import { ArrayMaxSize, ArrayMinSize, Equals, IsArray, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CheckoutItemDto {
  @IsString() @Matches(/^[A-Za-z0-9_.=-]{1,128}$/) productId!: string;
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_.=-]{1,128}$/) variantId?: string;
  @IsInt() @Min(1) @Max(100) quantity!: number;
}
export class DeliveryDto {
  @IsString() @MaxLength(100) firstName!: string;
  @IsString() @MaxLength(100) lastName!: string;
  @IsString() @MaxLength(254) email!: string;
  @IsString() @MaxLength(30) phone!: string;
  @IsString() @MaxLength(200) addressLine1!: string;
  @IsOptional() @IsString() @MaxLength(200) addressLine2?: string;
  @IsString() @MaxLength(100) city!: string;
  @IsString() @MaxLength(30) province!: string;
  @IsString() @Matches(/^\d{4}$/) postalCode!: string;
  @Equals('ZA') country!: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}
export class CheckoutDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => CheckoutItemDto) items!: CheckoutItemDto[];
  @Equals('ZAR') currency!: string;
  @Equals(true) termsAccepted!: boolean;
  @ValidateNested() @Type(() => DeliveryDto) delivery!: DeliveryDto;
}
export class CheckoutReferenceDto {
  @IsString() @Matches(/^[A-Za-z0-9_.=-]{1,128}$/) reference!: string;
}
