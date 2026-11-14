import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PhoneVerificationController } from './phone-verification.controller';
import { PhoneVerificationService } from './phone-verification.service';
import { AuthModule } from '../auth/auth.module';
import { FirebaseAdminModule } from '../firebase-admin/firebase-admin.module';
import { PhoneVerificationPolicy } from './phone-verification.policy';
import { PhoneVerificationRecords } from './phone-verification.records';
import { TwilioVerificationProvider } from './phone-verification.provider';

@Module({
    imports: [ConfigModule, AuthModule, FirebaseAdminModule],
    controllers: [PhoneVerificationController],
    providers: [PhoneVerificationService, PhoneVerificationPolicy, PhoneVerificationRecords, TwilioVerificationProvider],
    exports: [PhoneVerificationService],
})
export class PhoneVerificationModule {}
