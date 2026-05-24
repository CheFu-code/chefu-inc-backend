import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AdminGuard } from './admin.guard';
import { AuthGuard } from './auth.guard';
import { MfaBackupCodeService } from './mfa-backup-code.service';
import { SessionSignerService } from './session-signer.service';
import { AppsModule } from '../apps/apps.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [AppsModule, EmailModule],
  controllers: [AuthController],
  providers: [AuthGuard, AdminGuard, SessionSignerService, MfaBackupCodeService],
  exports: [AuthGuard, AdminGuard, SessionSignerService],
})
export class AuthModule {}
