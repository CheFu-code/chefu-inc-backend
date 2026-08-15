import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FirebaseAdminModule } from '../firebase-admin/firebase-admin.module';
import { DrippybanksController } from './drippybanks.controller';
import { DrippybanksService } from './drippybanks.service';

@Module({
  imports: [AuthModule, FirebaseAdminModule],
  controllers: [DrippybanksController],
  providers: [DrippybanksService],
  exports: [DrippybanksService],
})
export class DrippybanksModule {}
