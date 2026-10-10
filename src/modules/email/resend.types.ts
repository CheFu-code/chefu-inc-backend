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

export interface AccountEmailVerificationData {
    email: string;
    userName?: string;
    verificationUrl: string;
}

export interface AccountDeletionConfirmationData {
    email: string;
    userName?: string;
    deletedAt?: Date;
}