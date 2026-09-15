import {
    BadRequestException,
    Injectable,
    Logger,
    TooManyRequestsException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { randomUUID } from 'crypto';

import { generateOtp, hashOtp, verifyOtpHash } from './utils/otp.util';
import {
    WhatsappOtpRecord,
    WhatsappSendResult,
    WhatsappWebhookStatus,
} from './whatsapp.types';

@Injectable()
export class WhatsappService {
    private readonly logger = new Logger(WhatsappService.name);

    /**
     * Temporary in-memory storage.
     *
     * IMPORTANT:
     * Replace this with Firestore/Redis/PostgreSQL/etc.
     * before production.
     */
    private readonly otpStore = new Map<string, WhatsappOtpRecord>();

    constructor(
        private readonly httpService: HttpService,
        private readonly configService: ConfigService,
    ) { }

    /**
     * Send WhatsApp OTP.
     */
    async sendOtp(phone: string): Promise<{
        success: boolean;
        message: string;
        messageId?: string;
    }> {
        const normalizedPhone = this.normalizePhone(phone);

        const existing = this.otpStore.get(normalizedPhone);

        if (existing && !existing.used) {
            const cooldown =
                this.getNumberConfig(
                    'WHATSAPP_OTP_RESEND_COOLDOWN_SECONDS',
                    60,
                ) * 1000;

            const elapsed =
                Date.now() - existing.lastSentAt.getTime();

            if (elapsed < cooldown) {
                const remaining = Math.ceil(
                    (cooldown - elapsed) / 1000,
                );

                throw new TooManyRequestsException(
                    `Please wait ${remaining} seconds before requesting another code.`,
                );
            }
        }

        const otp = generateOtp(6);

        const expirySeconds = this.getNumberConfig(
            'WHATSAPP_OTP_EXPIRY_SECONDS',
            300,
        );

        const maxAttempts = this.getNumberConfig(
            'WHATSAPP_OTP_MAX_ATTEMPTS',
            5,
        );

        const record: WhatsappOtpRecord = {
            id: randomUUID(),
            phone: normalizedPhone,
            codeHash: hashOtp(otp),
            expiresAt: new Date(
                Date.now() + expirySeconds * 1000,
            ),
            attempts: 0,
            maxAttempts,
            used: false,
            createdAt: new Date(),
            lastSentAt: new Date(),
        };

        /*
         * Send the OTP through Meta BEFORE considering
         * the OTP successfully issued.
         */
        const result = await this.sendAuthenticationTemplate(
            normalizedPhone,
            otp,
        );

        if (!result.success) {
            this.logger.error(
                `Failed to send WhatsApp OTP to ${this.maskPhone(normalizedPhone)}`,
            );

            throw new BadRequestException(
                'Unable to send WhatsApp verification code.',
            );
        }

        record.whatsappMessageId = result.messageId;

        this.otpStore.set(normalizedPhone, record);

        this.logger.log(
            `WhatsApp OTP sent to ${this.maskPhone(normalizedPhone)}`,
        );

        return {
            success: true,
            message:
                'Verification code sent to your WhatsApp.',
            messageId: result.messageId,
        };
    }

    /**
     * Verify OTP.
     */
    async verifyOtp(
        phone: string,
        code: string,
    ): Promise<{
        success: boolean;
        verified: boolean;
        message: string;
    }> {
        const normalizedPhone = this.normalizePhone(phone);

        const record = this.otpStore.get(normalizedPhone);

        if (!record) {
            throw new BadRequestException(
                'No active verification code found.',
            );
        }

        if (record.used) {
            throw new BadRequestException(
                'This verification code has already been used.',
            );
        }

        if (record.expiresAt.getTime() < Date.now()) {
            this.otpStore.delete(normalizedPhone);

            throw new BadRequestException(
                'Verification code has expired.',
            );
        }

        if (record.attempts >= record.maxAttempts) {
            this.otpStore.delete(normalizedPhone);

            throw new TooManyRequestsException(
                'Too many incorrect attempts. Please request a new code.',
            );
        }

        record.attempts++;

        const valid = verifyOtpHash(
            code,
            record.codeHash,
        );

        if (!valid) {
            this.otpStore.set(normalizedPhone, record);

            const remaining =
                record.maxAttempts - record.attempts;

            throw new BadRequestException(
                `Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'
                } remaining.`,
            );
        }

        record.used = true;

        this.otpStore.set(normalizedPhone, record);

        /*
         * IMPORTANT:
         *
         * This is where you should update your actual
         * CHEFU/Firebase user:
         *
         * phoneVerified = true
         *
         * and/or link the verified phone credential.
         */

        this.logger.log(
            `WhatsApp phone verified: ${this.maskPhone(normalizedPhone)}`,
        );

        return {
            success: true,
            verified: true,
            message: 'WhatsApp number verified successfully.',
        };
    }

    /**
     * Send Meta authentication template.
     */
    private async sendAuthenticationTemplate(
        phone: string,
        otp: string,
    ): Promise<WhatsappSendResult> {
        const accessToken =
            this.configService.get<string>(
                'WHATSAPP_ACCESS_TOKEN',
            );

        const phoneNumberId =
            this.configService.get<string>(
                'WHATSAPP_PHONE_NUMBER_ID',
            );

        const apiVersion =
            this.configService.get<string>(
                'WHATSAPP_API_VERSION',
            ) ?? 'v23.0';

        const templateName =
            this.configService.get<string>(
                'WHATSAPP_OTP_TEMPLATE_NAME',
            ) ?? 'chefu_login_code';

        const language =
            this.configService.get<string>(
                'WHATSAPP_OTP_LANGUAGE',
            ) ?? 'en_US';

        if (!accessToken || !phoneNumberId) {
            this.logger.error(
                'WhatsApp Cloud API environment variables are missing.',
            );

            return {
                success: false,
                error: 'WhatsApp configuration missing.',
            };
        }

        const url =
            `https://graph.facebook.com/${apiVersion}` +
            `/${phoneNumberId}/messages`;

        /*
         * This payload is for a template whose OTP is
         * supplied as a template variable.
         *
         * If your Meta authentication template uses the
         * specialized copy-code authentication component,
         * adjust the components section to exactly match
         * the approved template configuration.
         */
        const payload = {
            messaging_product: 'whatsapp',
            to: phone,
            type: 'template',
            template: {
                name: templateName,
                language: {
                    code: language,
                },
                components: [
                    {
                        type: 'body',
                        parameters: [
                            {
                                type: 'text',
                                text: otp,
                            },
                        ],
                    },
                ],
            },
        };

        try {
            const response = await firstValueFrom(
                this.httpService.post(
                    url,
                    payload,
                    {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            'Content-Type': 'application/json',
                        },
                        timeout: 10000,
                    },
                ),
            );

            const messageId =
                response.data?.messages?.[0]?.id;

            return {
                success: true,
                messageId,
            };
        } catch (error: any) {
            const responseData =
                error?.response?.data;

            this.logger.error(
                'Meta WhatsApp API error',
                JSON.stringify(responseData),
            );

            return {
                success: false,
                error:
                    responseData?.error?.message ??
                    error?.message ??
                    'Unknown WhatsApp API error',
            };
        }
    }

    /**
     * Webhook status processing.
     */
    processWebhookStatus(
        status: WhatsappWebhookStatus,
    ): void {
        this.logger.log(
            `WhatsApp message ${status.id}: ${status.status}`,
        );

        /*
         * You can persist these statuses in Firestore:
         *
         * whatsappMessages/{messageId}
         *
         * {
         *   status,
         *   recipientId,
         *   timestamp,
         *   errors
         * }
         */
    }

    /**
     * Process incoming webhook payload.
     */
    processWebhook(payload: any): void {
        try {
            const entries = payload?.entry ?? [];

            for (const entry of entries) {
                const changes = entry?.changes ?? [];

                for (const change of changes) {
                    const value = change?.value;

                    if (!value) {
                        continue;
                    }

                    /*
                     * Status updates for messages sent by CHEFU.
                     */
                    const statuses =
                        value?.statuses ?? [];

                    for (const status of statuses) {
                        this.processWebhookStatus({
                            id: status.id,
                            status: status.status,
                            timestamp: status.timestamp,
                            recipientId:
                                status.recipient_id,
                            errors: status.errors,
                        });
                    }

                    /*
                     * Incoming WhatsApp messages.
                     *
                     * For an OTP-only system you may not need this,
                     * but keeping it here makes the module extensible.
                     */
                    const messages =
                        value?.messages ?? [];

                    for (const message of messages) {
                        this.logger.log(
                            `Incoming WhatsApp message: ${message.id}`,
                        );

                        /*
                         * Do NOT use incoming WhatsApp messages
                         * to verify the OTP.
                         *
                         * OTP verification happens through your
                         * /verify-code endpoint.
                         */
                    }
                }
            }
        } catch (error) {
            this.logger.error(
                'Failed to process WhatsApp webhook',
                error,
            );
        }
    }

    /**
     * Normalize phone number.
     */
    private normalizePhone(phone: string): string {
        return phone.trim().replace(/\s+/g, '');
    }

    /**
     * Mask phone number in logs.
     */
    private maskPhone(phone: string): string {
        if (phone.length <= 6) {
            return '***';
        }

        return (
            phone.slice(0, 4) +
            '***' +
            phone.slice(-3)
        );
    }

    private getNumberConfig(
        key: string,
        fallback: number,
    ): number {
        const value =
            this.configService.get<string>(key);

        if (!value) {
            return fallback;
        }

        const parsed = Number(value);

        return Number.isFinite(parsed)
            ? parsed
            : fallback;
    }
}