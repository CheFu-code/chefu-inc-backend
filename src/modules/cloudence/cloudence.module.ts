import { Module } from '@nestjs/common';
import { CloudinaryStorageModule } from '../../common/cloudinary-storage.module';
import { AuthModule } from '../auth/auth.module';
import { FirebaseAdminModule } from '../firebase-admin/firebase-admin.module';
import { CloudenceController } from './cloudence.controller';
import { CloudenceService } from './cloudence.service';
import { CloudenceUploadGuard } from './cloudence-upload.guard';

@Module({
  imports: [AuthModule, FirebaseAdminModule, CloudinaryStorageModule],
  controllers: [CloudenceController],
  providers: [CloudenceService, CloudenceUploadGuard],
})
export class CloudenceModule {}
