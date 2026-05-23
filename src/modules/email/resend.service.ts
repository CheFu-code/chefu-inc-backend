import { Injectable, Logger } from '@nestjs/common';

export interface SignInNotificationData {
  email: string;
  userName?: string;
  provider: string;
  deviceInfo?: string;
  ipAddress?: string;
  timestamp: Date;
}

export interface PasswordChangedNotificationData {
  email: string;
  userName?: string;
  deviceInfo?: string;
  ipAddress?: string;
  timestamp: Date;
}

@Injectable()
export class ResendService {
  private readonly logger = new Logger(ResendService.name);
  private readonly RESEND_API_KEY = process.env.RESEND_API_KEY;
  private readonly RESEND_API_URL = 'https://api.resend.com/emails';
  private readonly signInTemplateId = process.env.SIGNIN_ALERT_TEMPLATE_ID;
  private readonly passwordChangedTemplateId =
    process.env.PASSWORD_CHANGED_TEMPLATE_ID;
  private readonly fromAddress =
    process.env.SIGNIN_ALERT_FROM ||
    process.env.SECURITY_EMAIL_FROM ||
    'CheFu Academy <security@chefu.education>';
  private readonly supportUrl =
    process.env.SIGNIN_ALERT_SUPPORT_URL ||
    'https://academy.chefuinc.com/support';
  private readonly securityUrl =
    process.env.SIGNIN_ALERT_SECURITY_URL ||
    'https://academy.chefuinc.com/settings/account';

  async sendSignInNotification(data: SignInNotificationData): Promise<void> {
    if (!this.RESEND_API_KEY) {
      this.logger.warn('RESEND_API_KEY is not configured - skipping email');
      return;
    }

    const response = await fetch(this.RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.getSignInPayload(data)),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Resend request failed: ${response.status} ${error}`);
    }

    this.logger.log(
      JSON.stringify({
        event: 'sign_in_notification_sent',
        email: data.email,
      }),
    );
  }

  async sendPasswordChangedNotification(
    data: PasswordChangedNotificationData,
  ): Promise<void> {
    if (!this.RESEND_API_KEY) {
      this.logger.warn('RESEND_API_KEY is not configured - skipping email');
      return;
    }

    const response = await fetch(this.RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.getPasswordChangedPayload(data)),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Resend request failed: ${response.status} ${error}`);
    }

    this.logger.log(
      JSON.stringify({
        event: 'password_changed_notification_sent',
        email: data.email,
      }),
    );
  }

  private getSignInPayload(data: SignInNotificationData) {
    const details = this.getDetails(data);
    const basePayload = {
      from: this.fromAddress,
      to: [data.email],
      subject: 'Security alert: new sign-in to CheFu Academy',
    };

    if (this.signInTemplateId) {
      return {
        ...basePayload,
        template: {
          id: this.signInTemplateId,
          variables: {
            userName: details.userName,
            APP_NAME: 'CheFu Academy',
            provider: details.provider,
            time: details.time,
            device: details.device || 'Unknown device',
            ipAddress: details.ipAddress || 'Unknown IP address',
            securityUrl: this.securityUrl,
            supportUrl: this.supportUrl,
            year: new Date().getUTCFullYear().toString(),
          },
        },
      };
    }

    return {
      ...basePayload,
      html: this.getSignInEmailTemplate(data),
      text: this.getSignInEmailText(data),
    };
  }

  private getSignInEmailText(data: SignInNotificationData): string {
    const details = this.getDetails(data);

    return [
      `Hi ${details.userName},`,
      '',
      'We noticed a new sign-in to your CheFu Academy account.',
      '',
      `Method: ${details.provider}`,
      `Time: ${details.time}`,
      details.device ? `Device: ${details.device}` : '',
      details.ipAddress ? `IP address: ${details.ipAddress}` : '',
      '',
      'If this was you, no action is needed.',
      `If this was not you, secure your account now: ${this.securityUrl}`,
      '',
      `Support: ${this.supportUrl}`,
      '',
      'CheFu Academy Security',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private getPasswordChangedPayload(data: PasswordChangedNotificationData) {
    const details = this.getPasswordDetails(data);
    const basePayload = {
      from: this.fromAddress,
      to: [data.email],
      subject: 'Security alert: your CheFu Academy password changed',
    };

    if (this.passwordChangedTemplateId) {
      return {
        ...basePayload,
        template: {
          id: this.passwordChangedTemplateId,
          variables: {
            userName: details.userName,
            APP_NAME: 'CheFu Academy',
            time: details.time,
            device: details.device || 'Unknown device',
            ipAddress: details.ipAddress || 'Unknown IP address',
            securityUrl: this.securityUrl,
            supportUrl: this.supportUrl,
            year: new Date().getUTCFullYear().toString(),
          },
        },
      };
    }

    return {
      ...basePayload,
      html: this.getPasswordChangedEmailTemplate(data),
      text: this.getPasswordChangedEmailText(data),
    };
  }

  private getPasswordChangedEmailText(
    data: PasswordChangedNotificationData,
  ): string {
    const details = this.getPasswordDetails(data);

    return [
      `Hi ${details.userName},`,
      '',
      'Your CheFu Academy password was changed.',
      '',
      `Time: ${details.time}`,
      details.device ? `Device: ${details.device}` : '',
      details.ipAddress ? `IP address: ${details.ipAddress}` : '',
      '',
      'If this was you, no action is needed.',
      `If this was not you, secure your account now: ${this.securityUrl}`,
      '',
      `Support: ${this.supportUrl}`,
      '',
      'CheFu Academy Security',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private getPasswordChangedEmailTemplate(
    data: PasswordChangedNotificationData,
  ): string {
    const details = this.getPasswordDetails(data);

    return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Password changed on CheFu Academy</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f7fb;color:#111827;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fb;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="background:#0f172a;padding:30px 28px;color:#ffffff;">
                <div style="display:inline-block;background:#22c55e;color:#052e16;border-radius:999px;padding:6px 10px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">
                  Account security
                </div>
                <h1 style="margin:18px 0 0;font-size:28px;line-height:1.2;font-weight:800;">
                  Your password was changed
                </h1>
                <p style="margin:10px 0 0;color:#cbd5e1;font-size:15px;line-height:1.6;">
                  We are letting you know because this protects your CheFu Academy account.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:30px 28px;">
                <p style="margin:0 0 18px;font-size:16px;line-height:1.7;">
                  Hi ${details.userName},
                </p>
                <p style="margin:0 0 22px;color:#374151;font-size:15px;line-height:1.7;">
                  Your password was changed successfully. If you made this change, no further action is needed.
                </p>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;background:#f9fafb;">
                  ${this.detailRow('Time', details.time)}
                  ${details.device ? this.detailRow('Device', details.device) : ''}
                  ${
                    details.ipAddress
                      ? this.detailRow('IP address', details.ipAddress)
                      : ''
                  }
                </table>

                <div style="margin:24px 0;padding:18px;border-radius:12px;background:#fef2f2;border:1px solid #fecaca;">
                  <p style="margin:0 0 8px;color:#991b1b;font-size:15px;font-weight:800;">
                    Did not change your password?
                  </p>
                  <p style="margin:0;color:#7f1d1d;font-size:14px;line-height:1.6;">
                    Secure your account immediately and contact support so we can help protect your learning profile.
                  </p>
                </div>

                <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 22px;">
                  <tr>
                    <td>
                      <a href="${this.escapeAttribute(this.securityUrl)}" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;border-radius:8px;padding:12px 18px;font-size:14px;font-weight:700;">
                        Secure account
                      </a>
                    </td>
                    <td style="padding-left:10px;">
                      <a href="${this.escapeAttribute(this.supportUrl)}" style="display:inline-block;background:#ffffff;color:#0369a1;text-decoration:none;border:1px solid #bae6fd;border-radius:8px;padding:11px 18px;font-size:14px;font-weight:700;">
                        Contact support
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;">
                  This message was sent automatically by CheFu Academy to help protect your account.
                </p>
              </td>
            </tr>

            <tr>
              <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 28px;color:#6b7280;font-size:12px;line-height:1.6;">
                <strong style="color:#374151;">CheFu Academy Security</strong><br>
                Copyright ${new Date().getUTCFullYear()} CheFu Inc. All rights reserved.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  }

  private getSignInEmailTemplate(data: SignInNotificationData): string {
    const details = this.getDetails(data);

    return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>New sign-in to CheFu Academy</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f7fb;color:#111827;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fb;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="background:#0f172a;padding:30px 28px;color:#ffffff;">
                <div style="display:inline-block;background:#38bdf8;color:#082f49;border-radius:999px;padding:6px 10px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">
                  Security alert
                </div>
                <h1 style="margin:18px 0 0;font-size:28px;line-height:1.2;font-weight:800;">
                  New sign-in detected
                </h1>
                <p style="margin:10px 0 0;color:#cbd5e1;font-size:15px;line-height:1.6;">
                  We noticed access to your CheFu Academy account.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:30px 28px;">
                <p style="margin:0 0 18px;font-size:16px;line-height:1.7;">
                  Hi ${details.userName},
                </p>
                <p style="margin:0 0 22px;color:#374151;font-size:15px;line-height:1.7;">
                  A new sign-in just happened. If this was you, you do not need to do anything.
                </p>

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;background:#f9fafb;">
                  ${this.detailRow('Sign-in method', details.provider)}
                  ${this.detailRow('Time', details.time)}
                  ${details.device ? this.detailRow('Device', details.device) : ''}
                  ${
                    details.ipAddress
                      ? this.detailRow('IP address', details.ipAddress)
                      : ''
                  }
                </table>

                <div style="margin:24px 0;padding:18px;border-radius:12px;background:#fff7ed;border:1px solid #fed7aa;">
                  <p style="margin:0 0 8px;color:#9a3412;font-size:15px;font-weight:800;">
                    Do not recognize this activity?
                  </p>
                  <p style="margin:0;color:#7c2d12;font-size:14px;line-height:1.6;">
                    Change your password, review your account, and enable two-factor authentication.
                  </p>
                </div>

                <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 0 22px;">
                  <tr>
                    <td>
                      <a href="${this.escapeAttribute(this.securityUrl)}" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;border-radius:8px;padding:12px 18px;font-size:14px;font-weight:700;">
                        Secure account
                      </a>
                    </td>
                    <td style="padding-left:10px;">
                      <a href="${this.escapeAttribute(this.supportUrl)}" style="display:inline-block;background:#ffffff;color:#0369a1;text-decoration:none;border:1px solid #bae6fd;border-radius:8px;padding:11px 18px;font-size:14px;font-weight:700;">
                        Contact support
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;">
                  This message was sent automatically by CheFu Academy to help protect your account.
                </p>
              </td>
            </tr>

            <tr>
              <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 28px;color:#6b7280;font-size:12px;line-height:1.6;">
                <strong style="color:#374151;">CheFu Academy Security</strong><br>
                Copyright ${new Date().getUTCFullYear()} CheFu Inc. All rights reserved.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  }

  private getDetails(data: SignInNotificationData) {
    return {
      userName: this.escapeHtml(data.userName || data.email.split('@')[0] || 'there'),
      provider: this.escapeHtml(this.formatProvider(data.provider)),
      time: this.escapeHtml(
        data.timestamp.toLocaleString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          timeZoneName: 'short',
        }),
      ),
      device: data.deviceInfo ? this.escapeHtml(data.deviceInfo) : '',
      ipAddress: data.ipAddress ? this.escapeHtml(data.ipAddress) : '',
    };
  }

  private getPasswordDetails(data: PasswordChangedNotificationData) {
    return {
      userName: this.escapeHtml(data.userName || data.email.split('@')[0] || 'there'),
      time: this.escapeHtml(
        data.timestamp.toLocaleString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          timeZoneName: 'short',
        }),
      ),
      device: data.deviceInfo ? this.escapeHtml(data.deviceInfo) : '',
      ipAddress: data.ipAddress ? this.escapeHtml(data.ipAddress) : '',
    };
  }

  private detailRow(label: string, value: string) {
    return `
      <tr>
        <td style="padding:14px 16px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:13px;font-weight:700;width:38%;">
          ${label}
        </td>
        <td style="padding:14px 16px;border-bottom:1px solid #e5e7eb;color:#111827;font-size:14px;font-weight:700;word-break:break-word;">
          ${value}
        </td>
      </tr>`;
  }

  private formatProvider(provider: string): string {
    const providers: Record<string, string> = {
      'google.com': 'Google',
      'facebook.com': 'Facebook',
      password: 'Email and password',
      anonymous: 'Anonymous',
      email: 'Email',
      custom: 'Custom token',
    };

    return providers[provider] || provider;
  }

  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };

    return text.replace(/[&<>"']/g, char => map[char]);
  }

  private escapeAttribute(text: string): string {
    return this.escapeHtml(text).replace(/`/g, '&#096;');
  }
}
