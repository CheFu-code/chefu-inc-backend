import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FirebaseAdminModule } from '../firebase-admin/firebase-admin.module';
import { LogixController } from './logix.controller';
import { LogixCompatController } from './logix-compat.controller';
import { LogixService } from './logix.service';

@Module({
  imports: [AuthModule, FirebaseAdminModule],
  controllers: [LogixController, LogixCompatController],
  providers: [LogixService],
  exports: [LogixService],
})
export class LogixModule {}
