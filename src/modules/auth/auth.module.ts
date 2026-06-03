import { Module, forwardRef } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { OAuthController, OAuthDiscoveryController } from './oauth.controller';
import { AdminGuard } from './admin.guard';
import { AuthGuard } from './auth.guard';
import { MfaBackupCodeService } from './mfa-backup-code.service';
import { OAuthService } from './oauth.service';
import { SessionSignerService } from './session-signer.service';
import { HoneytokenService } from './honeytoken.service';
import { SecurityEventsService } from './security-events.service';
import { AppsModule } from '../apps/apps.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [AppsModule, forwardRef(() => EmailModule)],
  controllers: [AuthController, OAuthController, OAuthDiscoveryController],
  providers: [
    AuthGuard,
    AdminGuard,
    SessionSignerService,
    MfaBackupCodeService,
    OAuthService,
    SecurityEventsService,
    HoneytokenService,
  ],
  exports: [
    AuthGuard,
    AdminGuard,
    OAuthService,
    SessionSignerService,
    SecurityEventsService,
    HoneytokenService,
  ],
})
export class AuthModule {}
