import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { FirebaseAdminModule } from "../firebase-admin/firebase-admin.module";
import { LiftWiseController } from "./liftwise.controller";
import { LiftWiseService } from "./liftwise.service";
import { LiftWiseAuthGuard } from "./liftwise-auth.guard";
import { LiftWiseCatalogService } from "./liftwise-catalog.service";
import { CloudinaryStorageModule } from "../../common/cloudinary-storage.module";

@Module({
  imports: [AuthModule, FirebaseAdminModule, CloudinaryStorageModule],
  controllers: [LiftWiseController],
  providers: [LiftWiseService, LiftWiseAuthGuard, LiftWiseCatalogService],
})
export class LiftWiseModule {}
