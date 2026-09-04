import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FirebaseAdminModule } from '../firebase-admin/firebase-admin.module';
import { DrippybanksController } from './drippybanks.controller';
import { DrippybanksService } from './drippybanks.service';
import { DrippybanksOrderCleanupService } from './drippybanks-order-cleanup.service';

@Module({
  imports: [AuthModule, FirebaseAdminModule],
  controllers: [DrippybanksController],
  providers: [DrippybanksService, DrippybanksOrderCleanupService],
  exports: [DrippybanksService, DrippybanksOrderCleanupService],
})
export class DrippybanksModule {}
