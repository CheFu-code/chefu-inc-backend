import { Global, Module } from '@nestjs/common';
import { RuntimeLimitService } from '../../common/runtime-limit.service';
import { FirebaseAdminService } from './firebase-admin.service';

@Global()
@Module({
  providers: [FirebaseAdminService, RuntimeLimitService],
  exports: [FirebaseAdminService, RuntimeLimitService],
})
export class FirebaseAdminModule {}
