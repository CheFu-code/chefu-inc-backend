import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Inject,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthGuard } from '../auth/auth.guard';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import {
  MfaSecurityEmailAction,
  MfaSecurityEmailService,
} from './mfa-security-email.service';
import { ResendService } from './resend.service';

type RequestWithUser = Request & {
  user?: AuthenticatedUser;
};

@Controller('email')
export class EmailController {
  private readonly logger = new Logger(EmailController.name);

  constructor(
    @Inject(ResendService)
    private readonly resendService: ResendService,
    @Inject(MfaSecurityEmailService)
    private readonly mfaSecurityEmail: MfaSecurityEmailService,
    @Inject(FirebaseAdminService)
    private readonly firebaseAdmin: FirebaseAdminService,
  ) {}

  @Post('password-changed')
  @UseGuards(AuthGuard)
  async passwordChanged(
    @Body() body: { deviceInfo?: string; userName?: string } | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Req() request: RequestWithUser,
  ) {
    const email = request.user?.email;

    this.logger.log(
      JSON.stringify({
        event: 'password_changed_email_started',
        hasAuthorization: Boolean(authorization),
        email,
      }),
    );

    if (!email) {
      return {
        sent: false,
        reason: 'Authenticated user email was not available.',
      };
    }

    await this.resendService.sendPasswordChangedNotification({
      email,
      userName: body?.userName,
      deviceInfo: body?.deviceInfo || request.headers['user-agent'],
      ipAddress: this.getClientIp(request),
      timestamp: new Date(),
    });

    this.logger.log(
      JSON.stringify({
        event: 'password_changed_email_finished',
        sent: true,
        email,
      }),
    );

    return {
      sent: true,
    };
  }

  @Post('passkey-added')
  @UseGuards(AuthGuard)
  async passkeyAdded(
    @Body()
    body:
      | {
          device?: string;
          origin?: string;
          userName?: string;
        }
      | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Req() request: RequestWithUser,
  ) {
    const email = request.user?.email;

    this.logger.log(
      JSON.stringify({
        event: 'passkey_added_email_started',
        hasAuthorization: Boolean(authorization),
        email,
      }),
    );

    if (!email) {
      return {
        sent: false,
        reason: 'Authenticated user email was not available.',
      };
    }

    const profile = await this.securityProfile(email);
    if (!profile.securityEmailsEnabled) {
      return {
        sent: false,
        reason: 'Security emails are disabled for this account.',
      };
    }

    try {
      const origin =
        body?.origin ||
        (request.headers.origin as string | undefined) ||
        'https://myaccount.chefu.co.za';

      await this.resendService.sendPasskeyAddedNotification({
        email,
        userName: body?.userName || profile.name || email.split('@')[0],
        device: body?.device || request.headers['user-agent'],
        addedAt: new Date(),
        origin,
        ipAddress: this.getClientIp(request),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown';

      this.logger.error(
        JSON.stringify({
          event: 'passkey_added_email_failed',
          email,
          reason,
        }),
        error instanceof Error ? error.stack : undefined,
      );

      return {
        sent: false,
        reason,
      };
    }

    this.logger.log(
      JSON.stringify({
        event: 'passkey_added_email_finished',
        sent: true,
        email,
      }),
    );

    return {
      sent: true,
    };
  }

  @Post('mfa-changed')
  @UseGuards(AuthGuard)
  async mfaChanged(
    @Body()
    body:
      | {
          action?: string;
          location?: string;
          userName?: string;
        }
      | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Req() request: RequestWithUser,
  ) {
    const email = request.user?.email;
    const action = this.normalizeMfaAction(body?.action);

    this.logger.log(
      JSON.stringify({
        event: 'mfa_changed_email_started',
        action,
        hasAuthorization: Boolean(authorization),
        email,
      }),
    );

    if (!email) {
      return {
        sent: false,
        reason: 'Authenticated user email was not available.',
      };
    }

    const profile = await this.securityProfile(email);
    if (!profile.securityEmailsEnabled) {
      return {
        sent: false,
        reason: 'Security emails are disabled for this account.',
      };
    }

    try {
      await this.mfaSecurityEmail.send({
        action,
        email,
        eventTime: new Date(),
        ipAddress: this.getClientIp(request),
        location: body?.location || profile.location,
        userName: body?.userName || profile.name,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown';

      this.logger.error(
        JSON.stringify({
          event: 'mfa_changed_email_failed',
          action,
          email,
          reason,
        }),
        error instanceof Error ? error.stack : undefined,
      );

      return {
        sent: false,
        reason,
      };
    }

    this.logger.log(
      JSON.stringify({
        event: 'mfa_changed_email_finished',
        action,
        sent: true,
        email,
      }),
    );

    return {
      sent: true,
    };
  }

  private getClientIp(request: Request) {
    const forwardedFor = request.headers['x-forwarded-for'];
    if (Array.isArray(forwardedFor)) return forwardedFor[0];
    if (forwardedFor) return forwardedFor.split(',')[0]?.trim();
    return request.ip;
  }

  private normalizeMfaAction(action?: string): MfaSecurityEmailAction {
    if (action === 'enabled' || action === 'disabled') return action;
    throw new BadRequestException('MFA action must be enabled or disabled.');
  }

  private async securityProfile(email: string) {
    const snapshot = await this.firebaseAdmin
      .db()
      .collection('users')
      .doc(email)
      .get();
    const data = snapshot.data() || {};
    const emailPreferences = data.emailPreferences as
      | { security?: unknown }
      | undefined;

    return {
      location: this.locationLabel(data),
      name: this.stringValue(data.name) || this.stringValue(data.fullname),
      securityEmailsEnabled: emailPreferences?.security !== false,
    };
  }

  private locationLabel(data: Record<string, unknown>) {
    const country =
      this.stringValue(data.country) ||
      this.stringValue(data.countryCode) ||
      this.stringValue(data.detectedCountryCode);

    return country || 'Unknown location';
  }

  private stringValue(value: unknown) {
    return typeof value === 'string' ? value.trim() : '';
  }
}
