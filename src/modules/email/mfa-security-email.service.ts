import { Injectable, Logger } from '@nestjs/common';

export type MfaSecurityEmailAction = 'enabled' | 'disabled';

export type MfaSecurityEmailData = {
  action: MfaSecurityEmailAction;
  email: string;
  eventTime: Date;
  ipAddress?: string;
  location?: string;
  userName?: string;
};

@Injectable()
export class MfaSecurityEmailService {
  private readonly logger = new Logger(MfaSecurityEmailService.name);
  private readonly resendApiKey = process.env.RESEND_API_KEY;
  private readonly resendApiUrl = 'https://api.resend.com/emails';
  private readonly enabledTemplateId =
    process.env.TWO_FACTOR_ENABLED_TEMPLATE_ID ||
    process.env['2FA_ENABLED_TEMPLATE_ID'] ||
    'two-factor-enabled';
  private readonly disabledTemplateId =
    process.env.TWO_FACTOR_DISABLED_TEMPLATE_ID ||
    process.env['2FA_DISABLED_TEMPLATE_ID'] ||
    '2fa-disabled';
  private readonly fromAddress = this.normalizeFromAddress(
    process.env.SECURITY_EMAIL_FROM ||
      process.env.SIGNIN_ALERT_FROM ||
      'CHEFU Account <security@chefuinc.com>',
  );
  private readonly securityUrl =
    process.env.SIGNIN_ALERT_SECURITY_URL ||
    'https://myaccount.chefuinc.com/account?section=security';
  private readonly supportUrl =
    process.env.SIGNIN_ALERT_SUPPORT_URL ||
    'https://academy.chefuinc.com/support';

  async send(data: MfaSecurityEmailData) {
    if (!this.resendApiKey) {
      this.logger.warn('RESEND_API_KEY is not configured - skipping MFA email');
      return;
    }

    const response = await fetch(this.resendApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.payload(data)),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Resend request failed: ${response.status} ${error}`);
    }

    this.logger.log(
      JSON.stringify({
        event: 'mfa_security_email_sent',
        action: data.action,
        email: data.email,
      }),
    );
  }

  private payload(data: MfaSecurityEmailData) {
    const isEnabled = data.action === 'enabled';

    return {
      from: this.fromAddress,
      to: [data.email],
      subject: isEnabled
        ? 'Two-factor authentication enabled on your account'
        : 'Two-factor authentication disabled on your account',
      template: {
        id: isEnabled ? this.enabledTemplateId : this.disabledTemplateId,
        variables: {
          accountEmail: data.email,
          eventTime: this.formatTime(data.eventTime),
          ipAddress: data.ipAddress || 'Unknown IP address',
          location: data.location || 'Unknown location',
          securityUrl: this.securityUrl,
          supportUrl: this.supportUrl,
          userName: data.userName || data.email.split('@')[0] || 'there',
        },
      },
    };
  }

  private formatTime(value: Date) {
    return value.toLocaleString('en-US', {
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      month: 'long',
      second: '2-digit',
      timeZoneName: 'short',
      year: 'numeric',
    });
  }

  private normalizeFromAddress(value: string) {
    const trimmed = value.trim().replace(/\\"/g, '"');
    const isDoubleQuoted = trimmed.startsWith('"') && trimmed.endsWith('"');
    const isSingleQuoted = trimmed.startsWith("'") && trimmed.endsWith("'");

    return isDoubleQuoted || isSingleQuoted
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  }
}
