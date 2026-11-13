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
import { ShopYethuAdminGuard } from './shopyethu-admin.guard';
import { ShopYethuSessionController } from './shopyethu-session.controller';

@Module({
  imports: [AppsModule, forwardRef(() => EmailModule)],
  controllers: [AuthController, OAuthController, OAuthDiscoveryController, PasskeyController, ShopYethuSessionController],
  providers: [
    ShopYethuAdminGuard,
    AuthGuard,
    AdminGuard,
    SessionSignerService,
    MfaBackupCodeService,
    OAuthService,
    PasskeyService,
    ProfilePictureService,
    SecurityEventsService,
    HoneytokenService,
  ],
  exports: [
    ShopYethuAdminGuard,
    AuthGuard,
    AdminGuard,
    OAuthService,
    PasskeyService,
    ProfilePictureService,
    SessionSignerService,
    SecurityEventsService,
    HoneytokenService,
  ],
})
export class AuthModule {}
