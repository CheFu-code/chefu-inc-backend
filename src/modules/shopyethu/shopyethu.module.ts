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

@Module({ imports: [AuthModule, CloudinaryStorageModule], providers: [MarketplaceAuthGuard, MarketplaceService, FirestoreMarketplaceRepository, GooglePlacesService, ApplicationEmailService, OrderEmailService], controllers: [MarketplacePublicController, MarketplaceCustomerController, MarketplaceAdminController, ProductPhotoController, ApplicationProofController, ApplicationAreasController, PublicAreasController] })
export class ShopYethuModule {}
