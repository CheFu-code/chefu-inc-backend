import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FirebaseAdminModule } from '../firebase-admin/firebase-admin.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

@Module({
  imports: [AuthModule, FirebaseAdminModule],
  controllers: [BillingController],
  providers: [BillingService],
})
export class BillingModule {}
