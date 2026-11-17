import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MarketplaceAuthGuard } from './marketplace-auth.guard';
import { MarketplaceService } from './marketplace.service';
import { FirestoreMarketplaceRepository } from './marketplace.repository';
import { MarketplaceCustomerController, MarketplacePublicController } from './marketplace.controller';
import { MarketplaceAdminController } from './marketplace-admin.controller';
import { CloudinaryStorageModule } from '../../common/cloudinary-storage.module';
import { ProductPhotoController } from './product-photo.controller';
import { ApplicationProofController } from './application-proof.controller';
import { ApplicationAreasController, PublicAreasController } from './google-places.controller';
import { GooglePlacesService } from './google-places.service';
import { ApplicationEmailService } from './application-email.service';
import { OrderEmailService } from './order-email.service';
import { ShopYethuAppLinksController } from './shopyethu-app-links.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({ imports: [AuthModule, CloudinaryStorageModule, NotificationsModule], providers: [MarketplaceAuthGuard, MarketplaceService, FirestoreMarketplaceRepository, GooglePlacesService, ApplicationEmailService, OrderEmailService], controllers: [MarketplacePublicController, MarketplaceCustomerController, MarketplaceAdminController, ProductPhotoController, ApplicationProofController, ApplicationAreasController, PublicAreasController, ShopYethuAppLinksController] })
export class ShopYethuModule {}
