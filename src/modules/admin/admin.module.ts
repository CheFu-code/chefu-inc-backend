import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminAppsService } from './admin-apps.service';
import { AdminController } from './admin.controller';

@Module({
  imports: [AuthModule],
  controllers: [AdminController],
  providers: [AdminAppsService],
})
export class AdminModule {}
