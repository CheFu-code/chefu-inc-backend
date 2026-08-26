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

export interface PasskeyAddedNotificationData {
    email: string;
    userName?: string;
    device?: string;
    addedAt?: Date;
    origin?: string;
    ipAddress?: string;
    securityUrl?: string;
    supportEmail?: string;
    year?: string;
    appId?: string;
}

@Injectable()
export class ResendService {
    private readonly logger = new Logger(ResendService.name);
    private readonly RESEND_API_KEY = process.env.RESEND_API_KEY;
    private readonly RESEND_API_URL = 'https://api.resend.com/emails';

    private readonly passkeyAddedTemplateId =
        process.env.PASSKEY_ADDED_TEMPLATE_ID ||
        process.env.NEW_PASSKEY_ADDED_TEMPLATE_ID ||
        'new-passkey-added';
    private readonly signInTemplateId =
        process.env.SIGNIN_ALERT_TEMPLATE_ID ||
        'signin-alert';
    private readonly passwordChangedTemplateId =
        process.env.PASSWORD_CHANGED_TEMPLATE_ID ||
        'password-changed';
    private readonly apiKeyCompromisedTemplateId =
        process.env.API_KEY_COMPROMISED_TEMPLATE_ID ||
        'api-key-compromised';
    private readonly welcomePromoTemplateId =
        process.env.WELCOME_PROMO_TEMPLATE_ID ||
        'welcome-promo';

    private readonly fromAddress =
        process.env.SIGNIN_ALERT_FROM ||
        process.env.SECURITY_EMAIL_FROM ||
        'Security <security@chefu.co.za>';
    private readonly supportUrl =
        process.env.SIGNIN_ALERT_SUPPORT_URL ||
        'https://chefu.co.za/support';
    private readonly securityUrl =
        process.env.SIGNIN_ALERT_SECURITY_URL ||
        'https://myaccount.chefu.co.za/account?section=security';
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

    async sendPasskeyAddedNotification(
        data: PasskeyAddedNotificationData,
    ): Promise<void> {
        const apiKey = this.getApiKey();

        const response = await fetch(this.RESEND_API_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(this.getPasskeyAddedPayload(data)),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Resend request failed: ${response.status} ${error}`);
        }

        this.logger.log(
            JSON.stringify({
                event: 'passkey_added_notification_sent',
                email: data.email,
            }),
        );
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

    private getPasskeyAddedPayload(data: PasskeyAddedNotificationData) {
        const details = this.getPasskeyAddedDetails(data);
        const fromAddress = this.resolveFromAddress(data.appId);

        return {
            from: fromAddress,
            to: [data.email],
            subject: 'Security alert: New passkey added',
            template: {
                id: this.passkeyAddedTemplateId,
                variables: {
                    USER_NAME: details.userName,
                    DEVICE: details.device,
                    ADDED_AT: details.addedAt,
                    ORIGIN: details.origin,
                    IP_ADDRESS: details.ipAddress,
                    SECURITY_URL: details.securityUrl,
                    SUPPORT_EMAIL: details.supportEmail,
                    YEAR: details.year,
                    userName: details.userName,
                    device: details.device,
                    addedAt: details.addedAt,
                    origin: details.origin,
                    ipAddress: details.ipAddress,
                    securityUrl: details.securityUrl,
                    supportEmail: details.supportEmail,
                    year: details.year,
                },
            },
        };
    }

    private getSignInPayload(data: SignInNotificationData) {
        const details = this.getDetails(data);
        const appLabel = this.resolveAppLabel(data.appId);
        const fromAddress = this.resolveFromAddress(data.appId);

        return {
            from: fromAddress,
            to: [data.email],
            subject: `Security alert: new sign-in to ${appLabel}`,
            template: {
                id: this.signInTemplateId,
                variables: {
                    USER_NAME: details.userName,
                    APP_NAME: appLabel,
                    PROVIDER: details.provider,
                    TIME: details.time,
                    DEVICE: details.device || 'Unknown device',
                    IP_ADDRESS: details.ipAddress || 'Unknown IP address',
                    SECURITY_URL: this.securityUrl,
                    SUPPORT_URL: this.supportUrl,
                    YEAR: new Date().getUTCFullYear().toString(),
                    userName: details.userName,
                    appName: appLabel,
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

    private getPasswordChangedPayload(data: PasswordChangedNotificationData) {
        const details = this.getPasswordDetails(data);
        
        return {
            from: this.fromAddress,
            to: [data.email],
            subject: `Security alert: your account password changed`,
            template: {
                id: this.passwordChangedTemplateId,
                variables: {
                    USER_NAME: details.userName,
                    TIME: details.time,
                    DEVICE: details.device || 'Unknown device',
                    IP_ADDRESS: details.ipAddress || 'Unknown IP address',
                    SECURITY_URL: this.securityUrl,
                    SUPPORT_URL: this.supportUrl,
                    YEAR: new Date().getUTCFullYear().toString(),
                    userName: details.userName,
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

    private getApiKeyCompromisedPayload(
        data: ApiKeyCompromisedNotificationData,
    ) {
        const details = {
            userName: data.userName || data.email.split('@')[0] || 'there',
            keyName: data.keyName || 'Untitled key',
            publicId: data.publicId,
            source: data.source || 'a public location',
            url: data.url || '',
            time: data.timestamp.toLocaleString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                timeZoneName: 'short',
            }),
        };

        return {
            from: this.fromAddress,
            to: [data.email],
            subject: 'Security alert: CHEFU Academy API key revoked',
            template: {
                id: this.apiKeyCompromisedTemplateId,
                variables: {
                    USER_NAME: details.userName,
                    KEY_NAME: details.keyName,
                    PUBLIC_ID: details.publicId,
                    SOURCE: details.source,
                    URL: details.url,
                    TIME: details.time,
                    SECURITY_URL: this.securityUrl,
                    SUPPORT_URL: this.supportUrl,
                    YEAR: new Date().getUTCFullYear().toString(),
                    userName: details.userName,
                    keyName: details.keyName,
                    publicId: details.publicId,
                    source: details.source,
                    url: details.url,
                    time: details.time,
                    securityUrl: this.securityUrl,
                    supportUrl: this.supportUrl,
                    year: new Date().getUTCFullYear().toString(),
                },
            },
        };
    }

    private getWelcomePromoPayload(data: WelcomePromoNotificationData) {
        const userName = data.userName || data.email.split('@')[0] || 'there';
        const expiryDate = data.expiryDate.toLocaleDateString('en-ZA', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
        const fromAddress = this.resolveNotificationFromAddress(data.appId);

        return {
            from: fromAddress,
            to: [data.email],
            subject: 'Your Drippy Banks welcome code is here',
            template: {
                id: this.welcomePromoTemplateId,
                variables: {
                    USER_NAME: userName,
                    PROMO_CODE: data.promoCode,
                    DISCOUNT_PERCENT: String(data.discountPercent),
                    EXPIRY_DATE: expiryDate,
                    YEAR: new Date().getUTCFullYear().toString(),
                    userName,
                    promoCode: data.promoCode,
                    discountPercent: String(data.discountPercent),
                    expiryDate,
                    year: new Date().getUTCFullYear().toString(),
                },
            },
        };
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
            userName: data.userName || data.email.split('@')[0] || 'there',
            provider: this.formatProvider(data.provider),
            time: data.timestamp.toLocaleString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                timeZoneName: 'short',
            }),
            device: data.deviceInfo ? this.formatDevice(data.deviceInfo) : '',
            ipAddress: data.ipAddress || '',
        };
    }

    private getPasswordDetails(data: PasswordChangedNotificationData) {
        return {
            userName: data.userName || data.email.split('@')[0] || 'there',
            time: data.timestamp.toLocaleString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                timeZoneName: 'short',
            }),
            device: data.deviceInfo ? this.formatDevice(data.deviceInfo) : '',
            ipAddress: data.ipAddress || '',
        };
    }

    private getPasskeyAddedDetails(data: PasskeyAddedNotificationData) {
        return {
            userName: data.userName || data.email.split('@')[0] || 'there',
            device: this.formatDevice(data.device),
            addedAt: this.formatAddedAt(data.addedAt),
            origin: data.origin || 'https://myaccount.chefu.co.za',
            ipAddress: data.ipAddress || 'Unknown IP address',
            securityUrl: data.securityUrl || this.securityUrl,
            supportEmail: data.supportEmail || process.env.SUPPORT_EMAIL || 'support@chefu.co.za',
            year: data.year || new Date().getUTCFullYear().toString(),
        };
    }

    private formatAddedAt(date?: Date): string {
        const d = date || new Date();
        return d.toLocaleString('en-US', {
            timeZone: 'UTC',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
    }

    private formatDevice(raw?: string): string {
        if (!raw) return 'Passkey Authenticator';

        const ua = raw;
        let os = '';
        if (/iPhone/i.test(ua)) os = 'iPhone';
        else if (/iPad/i.test(ua)) os = 'iPad';
        else if (/Macintosh|Mac OS X/i.test(ua)) os = 'macOS';
        else if (/Windows/i.test(ua)) os = 'Windows';
        else if (/Android/i.test(ua)) os = 'Android';
        else if (/Linux/i.test(ua)) os = 'Linux';
        else if (/CrOS/i.test(ua)) os = 'ChromeOS';

        let browser = '';
        if (/Edg\//i.test(ua)) browser = 'Edge';
        else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
        else if (/Chrome\//i.test(ua)) browser = 'Chrome';
        else if (/Safari\//i.test(ua)) browser = 'Safari';
        else if (/Firefox\//i.test(ua)) browser = 'Firefox';

        if (browser && os) {
            return `${browser} on ${os}`;
        }
        if (os) {
            return os;
        }
        if (browser) {
            return browser;
        }
        return raw.length > 60 ? `${raw.slice(0, 57)}...` : raw;
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
}
