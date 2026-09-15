export interface WhatsappOtpRecord {
    id: string;
    phone: string;
    codeHash: string;
    expiresAt: Date;
    attempts: number;
    maxAttempts: number;
    used: boolean;
    createdAt: Date;
    lastSentAt: Date;
    whatsappMessageId?: string;
}

export interface WhatsappSendResult {
    success: boolean;
    messageId?: string;
    error?: string;
}

export interface WhatsappWebhookStatus {
    id: string;
    status: string;
    timestamp?: string;
    recipientId?: string;
    errors?: unknown[];
}