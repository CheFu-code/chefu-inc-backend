import { IsBoolean, IsIn, ValidateIf } from "class-validator";

export class UpdateManagedUserDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  disabled?: boolean;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(["user", "admin", "moderator", "support"])
  role?: "user" | "admin" | "moderator" | "support";
}
