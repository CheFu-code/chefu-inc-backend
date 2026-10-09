import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { assertResendConfigured } from "../../common/env";

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
    location?: string;
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

export interface EmailVerificationData {
    email: string;
    userName?: string;
    code: string;
    expiresIn?: string;
    appName?: string;
}

export interface SignupWelcomeData {
    email: string;
    userName?: string;
    appName?: string;
}

@Injectable()
export class ResendService {
    private readonly logger = new Logger(ResendService.name);
    private readonly RESEND_API_URL = "https://api.resend.com/emails";
    private readonly passkeyAddedTemplateId = "new-passkey-added"
    private readonly signInTemplateId = "sign-in-alert"
    private readonly passwordChangedTemplateId = "password-reset-notification"
    private readonly apiKeyCompromisedTemplateId =
        process.env.API_KEY_COMPROMISED_TEMPLATE_ID || "api-key-compromised";
    private readonly emailVerificationTemplateId = "email-verification"
    private readonly signupEmailTemplateId = "welcome-email-1"

    private readonly fromAddress =
        this.normalizeFromAddress(
            "Security <security@chefu.co.za>",
        );
    private readonly supportUrl = "https://chefu.co.za/support";
    private readonly securityUrl =
        "https://myaccount.chefu.co.za/account?section=security";
    private readonly notificationFromAddress =
        this.normalizeFromAddress(
            process.env.NOTIFICATION_EMAIL_FROM ||
            process.env.SECURITY_EMAIL_FROM ||
            this.fromAddress,
        );
    private readonly securityFromByApp = this.parseSenderMap(
        process.env.SECURITY_EMAIL_FROM_BY_APP,
    );
    private readonly notificationFromByApp = this.parseSenderMap(
        process.env.NOTIFICATION_EMAIL_FROM_BY_APP,
    );

    private getApiKey(): string {
        assertResendConfigured();
        return (process.env.RESEND_API_KEY || "").trim();
    }

    async sendPasskeyAddedNotification(
        data: PasskeyAddedNotificationData,
    ): Promise<void> {
        const apiKey = this.getApiKey();

        const response = await fetch(this.RESEND_API_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(this.getPasskeyAddedPayload(data)),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Resend request failed: ${response.status} ${error}`);
        }

        this.logger.log(
            JSON.stringify({
                event: "passkey_added_notification_sent",
                email: data.email,
            }),
        );
    }

    async sendSignInNotification(data: SignInNotificationData): Promise<void> {
        const apiKey = this.getApiKey();

        const response = await fetch(this.RESEND_API_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(this.getSignInPayload(data)),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Resend request failed: ${response.status} ${error}`);
        }

        this.logger.log(
            JSON.stringify({
                event: "sign_in_notification_sent",
                email: data.email,
                ...this.getDeliveryDiagnostics(apiKey),
            }),
        );
    }

    async sendPasswordChangedNotification(
        data: PasswordChangedNotificationData,
    ): Promise<void> {
        const apiKey = this.getApiKey();

        const response = await fetch(this.RESEND_API_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(this.getPasswordChangedPayload(data)),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Resend request failed: ${response.status} ${error}`);
        }

        this.logger.log(
            JSON.stringify({
                event: "password_changed_notification_sent",
                email: data.email,
            }),
        );
    }

    async sendApiKeyCompromisedNotification(
        data: ApiKeyCompromisedNotificationData,
    ): Promise<void> {
        const apiKey = this.getApiKey();

        const response = await fetch(this.RESEND_API_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(this.getApiKeyCompromisedPayload(data)),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Resend request failed: ${response.status} ${error}`);
        }

        this.logger.log(
            JSON.stringify({
                event: "api_key_compromised_notification_sent",
                email: data.email,
                publicId: data.publicId,
            }),
        );
    }

    async sendEmailVerification(data: EmailVerificationData): Promise<void> {
        const rawApiKey = process.env.RESEND_API_KEY || "";
        const apiKey = this.getApiKey();
        const appName = data.appName || "Chefu Technologies";
        const userName = data.userName || data.email.split("@")[0] || "there";
        const expiresIn = data.expiresIn || "10 minutes";
        const year = new Date().getUTCFullYear().toString();

        const response = await fetch(this.RESEND_API_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                from: this.formatVerificationSender(appName),
                to: [data.email],
                subject: `Your ${appName} verification code`,
                template: {
                    id: this.emailVerificationTemplateId,
                    variables: {
                        VERIFICATION_CODE: data.code,
                        USER_NAME: userName,
                        APP_NAME: appName,
                        EXPIRES_IN: expiresIn,
                        YEAR: year,
                    },
                },
            }),
        });

        if (!response.ok) {
            const responseBody = await response.text();
            let providerError: Record<string, unknown> = {};
            try {
                const parsed = JSON.parse(responseBody) as Record<string, unknown>;
                providerError = {
                    ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
                    ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
                    ...(typeof parsed.statusCode === "number"
                        ? { statusCode: parsed.statusCode }
                        : {}),
                };
            } catch {
                providerError = { message: "Resend returned a non-JSON error response." };
            }

            const diagnostic = {
                event: "email_verification_resend_failed",
                statusCode: response.status,
                providerError,
                resendRequestId:
                    response.headers.get("x-resend-id") ||
                    response.headers.get("x-request-id") ||
                    null,
                templateId: this.emailVerificationTemplateId,
                senderDomain: this.getEmailDomain(
                    this.formatVerificationSender(appName),
                ),
                apiKeyConfigured: Boolean(apiKey),
                apiKeyHasBearerPrefix: /^Bearer\s/i.test(apiKey),
                apiKeyHasWrappingQuotes:
                    (apiKey.startsWith('"') && apiKey.endsWith('"')) ||
                    (apiKey.startsWith("'") && apiKey.endsWith("'")),
                apiKeyHasControlCharacters: /[\r\n\t]/.test(rawApiKey),
                apiKeyWasTrimmed: rawApiKey !== rawApiKey.trim(),
                ...this.getDeliveryDiagnostics(apiKey),
            };
            this.logger.error(JSON.stringify(diagnostic));
            throw new Error(
                `Resend request failed: ${response.status} ${JSON.stringify(providerError)}`,
            );
        }

        this.logger.log(
            JSON.stringify({
                event: "email_verification_resend_sent",
                statusCode: response.status,
                resendRequestId:
                    response.headers.get("x-resend-id") ||
                    response.headers.get("x-request-id") ||
                    null,
                templateId: this.emailVerificationTemplateId,
                senderDomain: this.getEmailDomain(
                    this.formatVerificationSender(appName),
                ),
                ...this.getDeliveryDiagnostics(apiKey),
            }),
        );
    }

    async sendSignupWelcomeEmail(data: SignupWelcomeData): Promise<void> {
        const apiKey = this.getApiKey();
        const appName = data.appName || "Chefu Technologies";
        const userName = data.userName || data.email.split("@")[0] || "there";
        const loginUrl = "https://myaccount.chefu.co.za/login";
        const supportEmail = process.env.SUPPORT_EMAIL || "support@chefu.co.za";
        const year = new Date().getUTCFullYear().toString();
        const response = await fetch(this.RESEND_API_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                from: this.formatVerificationSender(appName),
                to: [data.email],
                subject: `Welcome to ${appName}`,
                template: {
                    id: this.signupEmailTemplateId,
                    variables: {
                        USER_NAME: userName,
                        APP_NAME: appName,
                        LOGIN_URL: loginUrl,
                        SUPPORT_EMAIL: supportEmail,
                        YEAR: year,
                        userName,
                        appName,
                        loginUrl,
                        supportEmail,
                        year,
                    },
                },
            }),
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Resend request failed: ${response.status} ${error}`);
        }

        this.logger.log(
            JSON.stringify({
                event: "signup_welcome_email_sent",
                email: data.email,
                templateId: this.signupEmailTemplateId,
            }),
        );
    }

    private getDeliveryDiagnostics(apiKey: string) {
        return {
            apiKeyFingerprint: createHash("sha256")
                .update(apiKey)
                .digest("hex")
                .slice(0, 16),
            apiKeyLength: apiKey.length,
            apiKeyHasResendPrefix: apiKey.startsWith("re_"),
            flyApp: process.env.FLY_APP_NAME || null,
            flyMachine: process.env.FLY_MACHINE_ID || null,
            flyRegion: process.env.FLY_REGION || null,
        };
    }

    private getEmailDomain(address: string): string | null {
        const email = address.match(/<([^>]+)>/)?.[1] || address;
        const atIndex = email.lastIndexOf("@");
        return atIndex >= 0 ? email.slice(atIndex + 1).toLowerCase() : null;
    }

    private formatVerificationSender(appName: string) {
        const safeAppName =
            appName.replace(/[\r\n<>"]/g, "").trim().slice(0, 80) ||
            "Chefu Technologies";
        return `${safeAppName} <notifications@chefu.co.za>`;
    }

    private getPasskeyAddedPayload(data: PasskeyAddedNotificationData) {
        const details = this.getPasskeyAddedDetails(data);
        const fromAddress = this.resolveFromAddress(data.appId);

        return {
            from: fromAddress,
            to: [data.email],
            subject: "Security alert: New passkey added",
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
                    DEVICE: details.device || "Unknown device",
                    IP_ADDRESS: details.ipAddress || "Unknown IP address",
                    SECURITY_URL: this.securityUrl,
                    SUPPORT_URL: this.supportUrl,
                    YEAR: new Date().getUTCFullYear().toString(),
                    userName: details.userName,
                    appName: appLabel,
                    provider: details.provider,
                    time: details.time,
                    device: details.device || "Unknown device",
                    ipAddress: details.ipAddress || "Unknown IP address",
                    securityUrl: this.securityUrl,
                    supportUrl: this.supportUrl,
                    year: new Date().getUTCFullYear().toString(),
                },
            },
        };
    }

    private getPasswordChangedPayload(data: PasswordChangedNotificationData) {
        const details = this.getPasswordDetails(data);
        const year = new Date().getUTCFullYear().toString();

        return {
            from: this.fromAddress,
            to: [data.email],
            subject: `Security alert: your password was changed`,
            template: {
                id: this.passwordChangedTemplateId,
                variables: {
                    USER_NAME: details.userName,
                    USER_EMAIL: data.email,
                    CHANGED_AT: details.time,
                    DEVICE: details.device || "Unknown device",
                    LOCATION: details.location || "Unknown location",
                    IP_ADDRESS: details.ipAddress || "Unknown IP address",
                    YEAR: year,
                },
            },
        };
    }

    private getApiKeyCompromisedPayload(data: ApiKeyCompromisedNotificationData) {
        const details = {
            userName: data.userName || data.email.split("@")[0] || "there",
            keyName: data.keyName || "Untitled key",
            publicId: data.publicId,
            source: data.source || "a public location",
            url: data.url || "",
            time: data.timestamp.toLocaleString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                timeZoneName: "short",
            }),
        };

        return {
            from: this.fromAddress,
            to: [data.email],
            subject: "Security alert: Chefu Academy API key revoked",
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

    private resolveAppLabel(appId?: string) {
        if (!appId) return "Chefu Technologies";

        const normalized = appId.trim().toLowerCase();
        const labels: Record<string, string> = {
            academy: "Chefu Academy",
            admin: "Chefu Admin",
            flow: "Flow Mail",
            quantum: "Quantum",
            nook: "Nook",
        };

        return labels[normalized] || "Chefu Technologies";
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
            return Object.entries(parsed).reduce<Record<string, string>>(
                (acc, [key, value]) => {
                    if (typeof value === "string" && value.trim()) {
                        acc[key.trim().toLowerCase()] =
                            this.normalizeFromAddress(value);
                    }
                    return acc;
                },
                {},
            );
        } catch {
            this.logger.warn(
                "Invalid sender map JSON. Check SECURITY_EMAIL_FROM_BY_APP or NOTIFICATION_EMAIL_FROM_BY_APP.",
            );
            return {};
        }
    }

    private normalizeFromAddress(value: string) {
        const trimmed = value.trim().replace(/\\"/g, '"');
        const isDoubleQuoted = trimmed.startsWith('"') && trimmed.endsWith('"');
        const isSingleQuoted = trimmed.startsWith("'") && trimmed.endsWith("'");

        return isDoubleQuoted || isSingleQuoted
            ? trimmed.slice(1, -1).trim()
            : trimmed;
    }

    private normalizeAppId(appId?: string) {
        if (!appId) {
            return "";
        }
        return appId.trim().toLowerCase();
    }

    private getDetails(data: SignInNotificationData) {
        return {
            userName: data.userName || data.email.split("@")[0] || "there",
            provider: this.formatProvider(data.provider),
            time: data.timestamp.toLocaleString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                timeZoneName: "short",
            }),
            device: data.deviceInfo ? this.formatDevice(data.deviceInfo) : "",
            ipAddress: data.ipAddress || "",
        };
    }

    private getPasswordDetails(data: PasswordChangedNotificationData) {
        return {
            userName: data.userName || data.email.split("@")[0] || "there",
            time: data.timestamp.toLocaleString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                timeZoneName: "short",
            }),
            device: data.deviceInfo ? this.formatDevice(data.deviceInfo) : "",
            location: data.location || "Unknown location",
            ipAddress: data.ipAddress || "",
        };
    }

    private getPasskeyAddedDetails(data: PasskeyAddedNotificationData) {
        return {
            userName: data.userName || data.email.split("@")[0] || "there",
            device: this.formatDevice(data.device),
            addedAt: this.formatAddedAt(data.addedAt),
            origin: data.origin || "https://myaccount.chefu.co.za",
            ipAddress: data.ipAddress || "Unknown IP address",
            securityUrl: data.securityUrl || this.securityUrl,
            supportEmail:
                data.supportEmail || process.env.SUPPORT_EMAIL || "support@chefu.co.za",
            year: data.year || new Date().getUTCFullYear().toString(),
        };
    }

    private formatAddedAt(date?: Date): string {
        const d = date || new Date();
        return d.toLocaleString("en-US", {
            timeZone: "UTC",
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        });
    }

    private formatDevice(raw?: string): string {
        if (!raw) return "Passkey Authenticator";

        const ua = raw;
        let os = "";
        if (/iPhone/i.test(ua)) os = "iPhone";
        else if (/iPad/i.test(ua)) os = "iPad";
        else if (/Macintosh|Mac OS X/i.test(ua)) os = "macOS";
        else if (/Windows/i.test(ua)) os = "Windows";
        else if (/Android/i.test(ua)) os = "Android";
        else if (/Linux/i.test(ua)) os = "Linux";
        else if (/CrOS/i.test(ua)) os = "ChromeOS";

        let browser = "";
        if (/Edg\//i.test(ua)) browser = "Edge";
        else if (/OPR\/|Opera/i.test(ua)) browser = "Opera";
        else if (/Chrome\//i.test(ua)) browser = "Chrome";
        else if (/Safari\//i.test(ua)) browser = "Safari";
        else if (/Firefox\//i.test(ua)) browser = "Firefox";

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
            "google.com": "Google",
            "facebook.com": "Facebook",
            password: "Email and password",
            anonymous: "Anonymous",
            email: "Email",
            custom: "Passkey",
        };

        return providers[provider] || provider;
    }
}
