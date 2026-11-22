import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { UserManagementController } from "./user-management.controller";
import { UserManagementGuard } from "./user-management.guard";
import { UserManagementService } from "./user-management.service";

@Module({
  imports: [AuthModule],
  controllers: [UserManagementController],
  providers: [UserManagementGuard, UserManagementService],
})
export class UserManagementModule {}
