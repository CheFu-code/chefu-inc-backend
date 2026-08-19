import { Module, forwardRef } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { OAuthController, OAuthDiscoveryController } from './oauth.controller';
import { PasskeyController } from './passkey.controller';
import { AdminGuard } from './admin.guard';
import { AuthGuard } from './auth.guard';
import { MfaBackupCodeService } from './mfa-backup-code.service';
import { OAuthService } from './oauth.service';
import { PasskeyService } from './passkey.service';
import { ProfilePictureService } from './profile-picture.service';
import { SessionSignerService } from './session-signer.service';
import { HoneytokenService } from './honeytoken.service';
import { SecurityEventsService } from './security-events.service';
import { AppsModule } from '../apps/apps.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [AppsModule, forwardRef(() => EmailModule)],
  controllers: [AuthController, OAuthController, OAuthDiscoveryController, PasskeyController],
  providers: [
    AuthGuard,
    AdminGuard,
    SessionSignerService,
    MfaBackupCodeService,
    OAuthService,
    PasskeyService,
    SecurityEventsService,
    HoneytokenService,
  ],
  exports: [
    AuthGuard,
    AdminGuard,
    OAuthService,
    PasskeyService,
    SessionSignerService,
    SecurityEventsService,
    HoneytokenService,
  ],
})
export class AuthModule {}
