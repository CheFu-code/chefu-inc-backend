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
import { AcademySdkApiKeysService } from './services/academy-sdk-api-keys.service';
import { AcademySdkAuthService } from './services/academy-sdk-auth.service';
import { AcademySdkCatalogService } from './services/academy-sdk-catalog.service';

@Module({
  imports: [AuthModule, FirebaseAdminModule],
  controllers: [
    AcademySdkApiController,
    AcademySdkAuthController,
    AcademySdkKeysController,
  ],
  providers: [
    AcademySdkApiKeyGuard,
    AcademySdkApiKeysService,
    AcademySdkAuthService,
    AcademySdkCatalogService,
    AcademySdkCleanupService,
    AcademySdkService,
  ],
})
export class AcademySdkModule {}
