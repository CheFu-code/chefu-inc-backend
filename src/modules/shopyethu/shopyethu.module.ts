import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MarketplaceAuthGuard } from './marketplace-auth.guard';
import { MarketplaceService } from './marketplace.service';
import { FirestoreMarketplaceRepository } from './marketplace.repository';
import { MarketplaceCustomerController, MarketplacePublicController } from './marketplace.controller';
import { MarketplaceAdminController } from './marketplace-admin.controller';
import { CloudinaryStorageModule } from '../../common/cloudinary-storage.module';
import { ProductPhotoController } from './product-photo.controller';
import { ApplicationEmailService } from './application-email.service';

@Module({ imports: [AuthModule, CloudinaryStorageModule], providers: [MarketplaceAuthGuard, MarketplaceService, FirestoreMarketplaceRepository, ApplicationEmailService], controllers: [MarketplacePublicController, MarketplaceCustomerController, MarketplaceAdminController, ProductPhotoController] })
export class ShopYethuModule {}
