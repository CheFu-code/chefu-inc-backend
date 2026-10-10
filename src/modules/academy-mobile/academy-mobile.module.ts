import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FirebaseAdminModule } from '../firebase-admin/firebase-admin.module';
import { AcademyMobileController } from './academy-mobile.controller';
import { AcademyPublicController } from './academy-public.controller';
import { AcademyMobileService } from './academy-mobile.service';

@Module({
  imports: [AuthModule, FirebaseAdminModule],
  controllers: [AcademyMobileController, AcademyPublicController],
  providers: [AcademyMobileService],
})
export class AcademyMobileModule {}
