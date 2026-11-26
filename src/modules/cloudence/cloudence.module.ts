import { Module } from "@nestjs/common";
import { CloudflareR2StorageModule } from "../../common/cloudflare-r2-storage.module";
import { CloudinaryStorageModule } from "../../common/cloudinary-storage.module";
import { AuthModule } from "../auth/auth.module";
import { FirebaseAdminModule } from "../firebase-admin/firebase-admin.module";
import { CloudenceController } from "./cloudence.controller";
import { CloudenceService } from "./cloudence.service";
import { CloudenceUploadGuard } from "./cloudence-upload.guard";
import { CloudenceFoldersService } from "./cloudence-folders.service";
import { CloudenceNotificationsController } from "./cloudence-notifications.controller";
import { CloudenceNotificationsService } from "./cloudence-notifications.service";

@Module({
  imports: [
    AuthModule,
    FirebaseAdminModule,
    CloudinaryStorageModule,
    CloudflareR2StorageModule,
  ],
  controllers: [CloudenceController, CloudenceNotificationsController],
  providers: [
    CloudenceService,
    CloudenceUploadGuard,
    CloudenceFoldersService,
    CloudenceNotificationsService,
  ],
})
export class CloudenceModule {}
