import { Module } from '@nestjs/common';
import { FirebaseAdminModule } from '../firebase-admin/firebase-admin.module';
import { ProductsModule } from '../products/products.module';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { PaystackService } from './paystack.service';
import { AuthModule } from '../auth/auth.module';
import { CheckoutAccessGuard } from './checkout-access.guard';
import { StoreJobsService } from './store-jobs.service';
import { StoreAdminController } from './store-admin.controller';

@Module({
  imports: [FirebaseAdminModule, ProductsModule, AuthModule],
  controllers: [CheckoutController, StoreAdminController],
  providers: [CheckoutService, PaystackService, CheckoutAccessGuard, StoreJobsService],
})
export class StoreModule {}
