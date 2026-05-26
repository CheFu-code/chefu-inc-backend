import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FirebaseAdminModule } from '../firebase-admin/firebase-admin.module';
import { AcademySdkApiKeyGuard } from './academy-sdk-api-key.guard';
import {
  AcademySdkApiController,
  AcademySdkAuthController,
  AcademySdkKeysController,
} from './academy-sdk.controller';
import { AcademySdkCleanupService } from './academy-sdk-cleanup.service';
import { AcademySdkService } from './academy-sdk.service';

@Module({
  imports: [AuthModule, FirebaseAdminModule],
  controllers: [
    AcademySdkApiController,
    AcademySdkAuthController,
    AcademySdkKeysController,
  ],
  providers: [
    AcademySdkApiKeyGuard,
    AcademySdkCleanupService,
    AcademySdkService,
  ],
})
export class AcademySdkModule {}
