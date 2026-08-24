import { Injectable, Logger } from '@nestjs/common';
import { assertResendConfigured } from '../../common/env';

export interface SignInNotificationData {
  email: string;
  userName?: string;
  provider: string;
  deviceInfo?: string;
  ipAddress?: string;
  timestamp: Date;
  appId?: string;
}

export interface PasswordChangedNotificationData {
  email: string;
  userName?: string;
  deviceInfo?: string;
  ipAddress?: string;
  timestamp: Date;
}

export interface PreferenceNotificationData {
  email: string;
  type: string;
  subject: string;
  title: string;
  message: string;
  userName?: string;
  actionLabel?: string;
  actionUrl?: string;
  appId?: string;
}

export interface ApiKeyCompromisedNotificationData {
  email: string;
  userName?: string;
  keyName?: string;
  publicId: string;
  source?: string;
  url?: string;
  timestamp: Date;
}

export interface WelcomePromoNotificationData {
  email: string;
  userName?: string;
  promoCode: string;
  discountPercent: number;
  expiryDate: Date;
  appId?: string;
}

@Injectable()
export class ResendService {
  private readonly logger = new Logger(ResendService.name);
  private readonly RESEND_API_KEY = process.env.RESEND_API_KEY;
  private readonly RESEND_API_URL = 'https://api.resend.com/emails';
  private readonly signInTemplateId = process.env.SIGNIN_ALERT_TEMPLATE_ID;
  private readonly passwordChangedTemplateId =
    process.env.PASSWORD_CHANGED_TEMPLATE_ID;
  private readonly notificationTemplateId =
    process.env.NOTIFICATION_EMAIL_TEMPLATE_ID;
  private readonly welcomePromoTemplateId =
    process.env.WELCOME_PROMO_TEMPLATE_ID;
  private readonly fromAddress =
    process.env.SIGNIN_ALERT_FROM ||
    process.env.SECURITY_EMAIL_FROM ||
    'CHEFU Academy <security@chefu.co.za>';
  private readonly supportUrl =
    process.env.SIGNIN_ALERT_SUPPORT_URL ||
    'https://academy.chefu.co.za/support';
  private readonly securityUrl =
    process.env.SIGNIN_ALERT_SECURITY_URL ||
    'https://myaccount.chefu.co.za/account';
  private readonly notificationFromAddress =
    process.env.NOTIFICATION_EMAIL_FROM ||
    process.env.SECURITY_EMAIL_FROM ||
    this.fromAddress;
  private readonly securityFromByApp = this.parseSenderMap(
    process.env.SECURITY_EMAIL_FROM_BY_APP,
  );
  private readonly notificationFromByApp = this.parseSenderMap(
    process.env.NOTIFICATION_EMAIL_FROM_BY_APP,
  );

  private getApiKey(): string {
    assertResendConfigured();
    return (process.env.RESEND_API_KEY || '').trim();
  }

  async sendSignInNotification(data: SignInNotificationData): Promise<void> {
    const apiKey = this.getApiKey();

    const response = await fetch(this.RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
    const apiKey = this.getApiKey();

    const response = await fetch(this.RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
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

  async sendPreferenceNotification(
    data: PreferenceNotificationData,
  ): Promise<void> {
    const apiKey = this.getApiKey();

    const response = await fetch(this.RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.getPreferenceNotificationPayload(data)),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Resend request failed: ${response.status} ${error}`);
    }

    this.logger.log(
      JSON.stringify({
        event: 'preference_notification_sent',
        email: data.email,
        type: data.type,
      }),
    );
  }

  async sendApiKeyCompromisedNotification(
    data: ApiKeyCompromisedNotificationData,
  ): Promise<void> {
    const apiKey = this.getApiKey();

    const response = await fetch(this.RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.getApiKeyCompromisedPayload(data)),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Resend request failed: ${response.status} ${error}`);
    }

    this.logger.log(
      JSON.stringify({
        event: 'api_key_compromised_notification_sent',
        email: data.email,
        publicId: data.publicId,
      }),
    );
  }

  async sendWelcomePromoNotification(
    data: WelcomePromoNotificationData,
  ): Promise<void> {
    const apiKey = this.getApiKey();

    const response = await fetch(this.RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.getWelcomePromoPayload(data)),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Resend request failed: ${response.status} ${error}`);
    }

    this.logger.log(
      JSON.stringify({
        event: 'drippybanks_welcome_promo_sent',
        email: data.email,
        promoCode: data.promoCode,
      }),
    );
  }

  private getSignInPayload(data: SignInNotificationData) {
    const details = this.getDetails(data);
    const appLabel = this.resolveAppLabel(data.appId);
    const fromAddress = this.resolveFromAddress(data.appId);
    const basePayload = {
      from: fromAddress,
      to: [data.email],
      subject: `Security alert: new sign-in to ${appLabel}`,
    };

    if (this.signInTemplateId) {
      return {
        ...basePayload,
        template: {
          id: this.signInTemplateId,
          variables: {
            userName: details.userName,
            APP_NAME: appLabel,
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
    const appLabel = this.resolveAppLabel(data.appId);

    return [
      `Hi ${details.userName},`,
      '',
      `We noticed a new sign-in to your ${appLabel} account.`,
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
      `${appLabel} Security`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private getPasswordChangedPayload(data: PasswordChangedNotificationData) {
    const details = this.getPasswordDetails(data);
    const appLabel = 'CHEFU Account';
    const basePayload = {
      from: this.fromAddress,
      to: [data.email],
      subject: `Security alert: your ${appLabel} password changed`,
    };

    if (this.passwordChangedTemplateId) {
      return {
        ...basePayload,
        template: {
          id: this.passwordChangedTemplateId,
          variables: {
            userName: details.userName,
            APP_NAME: appLabel,
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

  private getPreferenceNotificationPayload(data: PreferenceNotificationData) {
    const details = {
      userName: this.escapeHtml(data.userName || data.email.split('@')[0] || 'there'),
      type: this.escapeHtml(this.formatNotificationType(data.type)),
      title: this.escapeHtml(data.title),
      message: this.escapeHtml(data.message),
      actionLabel: this.escapeHtml(data.actionLabel || 'Open CHEFU Academy'),
      actionUrl: data.actionUrl || 'https://academy.chefu.co.za/dashboard',
    };
    const basePayload = {
      from: this.notificationFromAddress,
      to: [data.email],
      subject: data.subject,
    };

    if (this.notificationTemplateId) {
      return {
        ...basePayload,
        template: {
          id: this.notificationTemplateId,
          variables: {
            userName: details.userName,
            APP_NAME: 'CHEFU Academy',
            type: details.type,
            title: details.title,
            message: details.message,
            actionLabel: details.actionLabel,
            actionUrl: details.actionUrl,
            preferencesUrl: 'https://academy.chefu.co.za/settings/account',
            supportUrl: this.supportUrl,
            year: new Date().getUTCFullYear().toString(),
          },
        },
      };
    }

    return {
      ...basePayload,
      html: this.getPreferenceNotificationTemplate(details),
      text: [
        `Hi ${details.userName},`,
        '',
        data.title,
        '',
        data.message,
        '',
        `${details.actionLabel}: ${details.actionUrl}`,
        'Manage preferences: https://academy.chefu.co.za/settings/account',
        '',
        'CHEFU Academy',
      ].join('\n'),
    };
  }

  private getApiKeyCompromisedPayload(
    data: ApiKeyCompromisedNotificationData,
  ) {
    const details = {
      userName: this.escapeHtml(data.userName || data.email.split('@')[0] || 'there'),
      keyName: this.escapeHtml(data.keyName || 'Untitled key'),
      publicId: this.escapeHtml(data.publicId),
      source: this.escapeHtml(data.source || 'a public location'),
      url: data.url || '',
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
    };
    const basePayload = {
      from: this.fromAddress,
      to: [data.email],
      subject: 'Security alert: CHEFU Academy API key revoked',
    };

    return {
      ...basePayload,
      html: this.getApiKeyCompromisedEmailTemplate(details),
      text: [
        `Hi ${details.userName},`,
        '',
        'A CHEFU Academy API key linked to your account appears to have been exposed.',
        'For your protection, we revoked the key immediately.',
        '',
        `Key name: ${details.keyName}`,
        `Public ID: ${details.publicId}`,
        `Detected from: ${details.source}`,
        `Time: ${details.time}`,
        details.url ? `Reference: ${details.url}` : '',
        '',
        'Create a new API key from the CHEFU Academy SDK CLI or dashboard if you still need access.',
        `Security settings: ${this.securityUrl}`,
        `Support: ${this.supportUrl}`,
        '',
        'CHEFU Security',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  private getWelcomePromoPayload(data: WelcomePromoNotificationData) {
    const userName = this.escapeHtml(
      data.userName || data.email.split('@')[0] || 'there',
    );
    const expiryDate = this.escapeHtml(
      data.expiryDate.toLocaleDateString('en-ZA', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    );

    const fromAddress = this.resolveNotificationFromAddress(data.appId);

    if (this.welcomePromoTemplateId) {
      return {
        from: fromAddress,
        to: [data.email],
        subject: 'Your Drippy Banks welcome code is here',
        template: {
          id: this.welcomePromoTemplateId,
          variables: {
            userName,
            promoCode: data.promoCode,
            discountPercent: String(data.discountPercent),
            expiryDate,
            year: new Date().getUTCFullYear().toString(),
          },
        },
      };
    }

    return {
      from: fromAddress,
      to: [data.email],
      subject: 'Your Drippy Banks welcome code is here',
      text: [
        `Hi ${userName},`,
        '',
        `Thanks for joining Drippy Banks. Your welcome code gives you ${data.discountPercent}% off your first order.`,
        '',
        `Promo code: ${data.promoCode}`,
        `Valid until: ${expiryDate}`,
        '',
        'Apply the code at checkout to redeem your discount.',
        '',
        'Drippy Banks',
      ].join('\n'),
    };
  }

  private getApiKeyCompromisedEmailTemplate(details: {
    userName: string;
    keyName: string;
    publicId: string;
    source: string;
    url: string;
    time: string;
  }) {
    return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CHEFU API key revoked</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f7fb;color:#111827;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fb;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="background:#7f1d1d;padding:30px 28px;color:#ffffff;">
                <div style="display:inline-block;background:#fecaca;color:#7f1d1d;border-radius:999px;padding:6px 10px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">
                  Security alert
                </div>
                <h1 style="margin:18px 0 0;font-size:28px;line-height:1.2;font-weight:800;">
                  API key revoked
                </h1>
                <p style="margin:10px 0 0;color:#fee2e2;font-size:15px;line-height:1.6;">
                  We detected a possible public exposure and revoked the key to protect your account.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:30px 28px;">
                <p style="margin:0 0 18px;font-size:16px;line-height:1.7;">Hi ${details.userName},</p>
                <p style="margin:0 0 22px;color:#374151;font-size:15px;line-height:1.7;">
                  A CHEFU API key linked to your account appears to have been exposed. For your protection, we revoked it immediately.
                </p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;background:#f9fafb;">
                  ${this.detailRow('Key name', details.keyName)}
                  ${this.detailRow('Public ID', details.publicId)}
                  ${this.detailRow('Detected from', details.source)}
                  ${this.detailRow('Time', details.time)}
                </table>
                ${details.url
        ? `<p style="margin:18px 0 0;color:#374151;font-size:14px;line-height:1.6;">Reference: <a href="${this.escapeAttribute(details.url)}" style="color:#0369a1;">${this.escapeHtml(details.url)}</a></p>`
        : ''
      }
                <div style="margin:24px 0;padding:18px;border-radius:12px;background:#fef2f2;border:1px solid #fecaca;">
                  <p style="margin:0 0 8px;color:#991b1b;font-size:15px;font-weight:800;">What to do next</p>
                  <p style="margin:0;color:#7f1d1d;font-size:14px;line-height:1.6;">
                    Remove the exposed key from public code or logs, then create a new API key if your app still needs access.
                  </p>
                </div>
                <a href="${this.escapeAttribute(this.securityUrl)}" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;border-radius:8px;padding:12px 18px;font-size:14px;font-weight:700;">
                  Review security settings
                </a>
              </td>
            </tr>
            <tr>
              <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 28px;color:#6b7280;font-size:12px;line-height:1.6;">
                <strong style="color:#374151;">CHEFU Security</strong><br>
                Copyright ${new Date().getUTCFullYear()} CHEFU Inc. All rights reserved.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  }

  private getPreferenceNotificationTemplate(details: {
    userName: string;
    type: string;
    title: string;
    message: string;
    actionLabel: string;
    actionUrl: string;
  }) {
    return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${details.title}</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f7fb;color:#111827;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fb;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="background:#0f172a;padding:30px 28px;color:#ffffff;">
                <div style="display:inline-block;background:#38bdf8;color:#082f49;border-radius:999px;padding:6px 10px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;">
                  ${details.type}
                </div>
                <h1 style="margin:18px 0 0;font-size:28px;line-height:1.2;font-weight:800;">
                  ${details.title}
                </h1>
              </td>
            </tr>
            <tr>
              <td style="padding:30px 28px;">
                <p style="margin:0 0 18px;font-size:16px;line-height:1.7;">Hi ${details.userName},</p>
                <p style="margin:0 0 22px;color:#374151;font-size:15px;line-height:1.7;">${details.message}</p>
                <a href="${this.escapeAttribute(details.actionUrl)}" style="display:inline-block;background:#0284c7;color:#ffffff;text-decoration:none;border-radius:8px;padding:12px 18px;font-size:14px;font-weight:700;">
                  ${details.actionLabel}
                </a>
                <p style="margin:24px 0 0;color:#6b7280;font-size:13px;line-height:1.6;">
                  You can manage email preferences from your CHEFU Academy account settings.
                </p>
              </td>
            </tr>
            <tr>
              <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 28px;color:#6b7280;font-size:12px;line-height:1.6;">
                <strong style="color:#374151;">CHEFU Academy</strong><br>
                Copyright ${new Date().getUTCFullYear()} CHEFU Inc. All rights reserved.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  }

  private getPasswordChangedEmailText(
    data: PasswordChangedNotificationData,
  ): string {
    const details = this.getPasswordDetails(data);
    const appLabel = 'CHEFU Account';

    return [
      `Hi ${details.userName},`,
      '',
      `Your ${appLabel} password was changed.`,
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
      `${appLabel} Security`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private getPasswordChangedEmailTemplate(
    data: PasswordChangedNotificationData,
  ): string {
    const details = this.getPasswordDetails(data);
    const appLabel = 'CHEFU Account';

    return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Password changed on ${appLabel}</title>
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
                  We are letting you know because this protects your ${appLabel} account.
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
                  ${details.ipAddress
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
                  This message was sent automatically by ${appLabel} to help protect your account.
                </p>
              </td>
            </tr>

            <tr>
              <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 28px;color:#6b7280;font-size:12px;line-height:1.6;">
                <strong style="color:#374151;">${appLabel} Security</strong><br>
                Copyright ${new Date().getUTCFullYear()} CHEFU Inc. All rights reserved.
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

    const appLabel = this.resolveAppLabel(data.appId);

    return `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>New sign-in to ${appLabel}</title>
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
                  We noticed access to your ${appLabel} account.
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
                  ${details.ipAddress
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
                  This message was sent automatically by ${appLabel} to help protect your account.
                </p>
              </td>
            </tr>

            <tr>
              <td style="background:#f9fafb;border-top:1px solid #e5e7eb;padding:20px 28px;color:#6b7280;font-size:12px;line-height:1.6;">
                <strong style="color:#374151;">${appLabel} Security</strong><br>
                Copyright ${new Date().getUTCFullYear()} CHEFU Inc. All rights reserved.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
  }

  private resolveAppLabel(appId?: string) {
    if (!appId) return 'CHEFU Account';

    const normalized = appId.trim().toLowerCase();
    const labels: Record<string, string> = {
      academy: 'CHEFU Academy',
      admin: 'CHEFU Admin',
      flow: 'Flow Mail',
      muzalo: 'Muzalo',
      quantum: 'Quantum',
      drippybanks: 'Drippy Banks',
    };

    return labels[normalized] || 'CHEFU Account';
  }

  private resolveFromAddress(appId?: string) {
    const normalized = this.normalizeAppId(appId);
    if (normalized) {
      const mapped = this.securityFromByApp[normalized];
      if (mapped) {
        return mapped;
      }
    }

    const appLabel = this.resolveAppLabel(appId);
    return `${appLabel} <security@chefu.co.za>`;
  }

  private resolveNotificationFromAddress(appId?: string) {
    const normalized = this.normalizeAppId(appId);
    if (normalized) {
      const mapped = this.notificationFromByApp[normalized];
      if (mapped) {
        return mapped;
      }
      const appLabel = this.resolveAppLabel(normalized);
      return `${appLabel} <notifications@chefu.co.za>`;
    }

    return this.notificationFromAddress;
  }

  private parseSenderMap(raw?: string): Record<string, string> {
    if (!raw) {
      return {};
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return Object.entries(parsed).reduce<Record<string, string>>((acc, [key, value]) => {
        if (typeof value === 'string' && value.trim()) {
          acc[key.trim().toLowerCase()] = value.trim();
        }
        return acc;
      }, {});
    } catch {
      this.logger.warn('Invalid sender map JSON. Check SECURITY_EMAIL_FROM_BY_APP or NOTIFICATION_EMAIL_FROM_BY_APP.');
      return {};
    }
  }

  private normalizeAppId(appId?: string) {
    if (!appId) {
      return '';
    }
    return appId.trim().toLowerCase();
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

  private formatNotificationType(type: string): string {
    const labels: Record<string, string> = {
      activity: 'Activity update',
      general: 'General update',
      marketing: 'Marketing update',
      security: 'Security notice',
      courseReminders: 'Course reminder',
      aiCourseCompletion: 'AI course update',
      weeklyProgressSummary: 'Weekly progress',
    };

    return labels[type] || type;
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
