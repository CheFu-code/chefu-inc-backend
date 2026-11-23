import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { UserManagementController } from "./user-management.controller";
import { UserManagementGuard } from "./user-management.guard";
import { UserManagementService } from "./user-management.service";
import { AppsModule } from '../apps/apps.module';
import { AppsController } from '../apps/apps.controller';

@Module({
  imports: [AuthModule, AppsModule],
  controllers: [UserManagementController, AppsController],
  providers: [UserManagementGuard, UserManagementService],
})
export class UserManagementModule {}
