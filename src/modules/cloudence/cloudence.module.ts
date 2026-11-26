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
import { CloudenceBillingController } from "./cloudence-billing.controller";
import { CloudenceBillingService } from "./cloudence-billing.service";
import { GooglePlayPublisherService } from "./google-play-publisher.service";
import { GooglePlayRtdnController } from "./google-play-rtdn.controller";

@Module({
  imports: [
    AuthModule,
    FirebaseAdminModule,
    CloudinaryStorageModule,
    CloudflareR2StorageModule,
  ],
  controllers: [
    CloudenceController,
    CloudenceNotificationsController,
    CloudenceBillingController,
    GooglePlayRtdnController,
  ],
  providers: [
    CloudenceService,
    CloudenceUploadGuard,
    CloudenceFoldersService,
    CloudenceNotificationsService,
    CloudenceBillingService,
    GooglePlayPublisherService,
  ],
})
export class CloudenceModule {}
