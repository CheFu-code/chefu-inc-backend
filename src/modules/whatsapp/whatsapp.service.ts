import {
    BadRequestException,
    Injectable,
    Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { DocumentData } from 'firebase-admin/firestore';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

import { generateOtp, hashOtp, verifyOtpHash } from './utils/otp.util';
import {
    WhatsappOtpRecord,
    WhatsappSendResult,
    WhatsappWebhookStatus,
} from './whatsapp.types';

@Injectable()
export class WhatsappService {
    private readonly logger = new Logger(WhatsappService.name);

    constructor(
        private readonly firebaseAdmin: FirebaseAdminService,
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

        const otpRef = this.getOtpReference(normalizedPhone);
        const existingSnapshot = await otpRef.get();
        const existing = existingSnapshot.exists
            ? this.readOtpRecord(existingSnapshot.data())
            : null;

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

                throw new BadRequestException(
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
            id: otpRef.id,
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


        const result = await this.sendAuthenticationTemplate(
            normalizedPhone,
            otp,
        );

        if (!result.success) {
            this.logger.error(
                `Failed to send WhatsApp OTP to ${this.maskPhone(normalizedPhone)}`,
            );

            throw new BadRequestException(
                'Unable to send verification code.',
            );
        }

        record.whatsappMessageId = result.messageId;

        await otpRef.set(record);

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
        userId: string,
    ): Promise<{
        success: boolean;
        verified: boolean;
        message: string;
    }> {
        const normalizedPhone = this.normalizePhone(phone);

        const otpRef = this.getOtpReference(normalizedPhone);
        let result: 'missing' | 'expired' | 'attempts' | 'invalid' | 'verified' = 'missing';
        let remainingAttempts = 0;

        await this.firebaseAdmin.db().runTransaction(async transaction => {
            const snapshot = await transaction.get(otpRef);
            if (!snapshot.exists) return;

            const record = this.readOtpRecord(snapshot.data());
            if (record.expiresAt.getTime() < Date.now()) {
                result = 'expired';
                transaction.delete(otpRef);
                return;
            }

            if (record.attempts >= record.maxAttempts) {
                result = 'attempts';
                transaction.delete(otpRef);
                return;
            }

            const valid = verifyOtpHash(code, record.codeHash);
            if (!valid) {
                const attempts = record.attempts + 1;
                remainingAttempts = Math.max(record.maxAttempts - attempts, 0);
                result = 'invalid';
                if (attempts >= record.maxAttempts) {
                    transaction.delete(otpRef);
                } else {
                    transaction.update(otpRef, { attempts });
                }
                return;
            }

            result = 'verified';
            transaction.delete(otpRef);
        });

        if (result === 'missing') {
            throw new BadRequestException('No active verification code found.');
        }
        if (result === 'expired') {
            throw new BadRequestException('Verification code has expired.');
        }
        if (result === 'attempts') {
            throw new BadRequestException('Too many incorrect attempts. Please request a new code.');
        }
        if (result === 'invalid') {
            throw new BadRequestException(
                `Invalid verification code. ${remainingAttempts} attempt${remainingAttempts === 1 ? '' : 's'} remaining.`,
            );
        }

        /*
         * The route is authenticated, so this links the verified number to
         * the Firebase account that initiated the challenge.
         */
        await this.firebaseAdmin.auth().updateUser(userId, {
            phoneNumber: normalizedPhone,
        });
        const user = await this.firebaseAdmin.auth().getUser(userId);
        if (!user.email) {
            throw new BadRequestException('Authenticated account email is missing.');
        }
        await this.firebaseAdmin
            .db()
            .collection('users')
            .doc(user.email)
            .set({ phone: normalizedPhone }, { merge: true });

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
        const accessToken = process.env.WHATSAPP_SYSTEM_USER_TOKEN?.trim();
        const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
        const apiVersion = process.env.WHATSAPP_API_VERSION?.trim() ?? 'v23.0';

        // Updated default to 'chefu_auth_code' as verified in your dashboard
        const templateName = process.env.WHATSAPP_OTP_TEMPLATE_NAME?.trim() ?? 'chefu_auth_code';
        const language = process.env.WHATSAPP_OTP_LANGUAGE?.trim() ?? 'en_US';

        const startedAt = Date.now();

        if (!accessToken || !phoneNumberId) {
            this.logger.error(
                JSON.stringify({
                    event: 'whatsapp_meta_config_missing',
                    hasAccessToken: Boolean(accessToken),
                    hasPhoneNumberId: Boolean(phoneNumberId),
                    hasTemplateName: Boolean(templateName),
                    hasLanguage: Boolean(language),
                }),
            );

            return {
                success: false,
                error: 'WhatsApp configuration missing.',
            };
        }

        const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
        const recipient = phone.replace(/^\+/, '');

        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: recipient,
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
                    {
                        type: 'button',
                        sub_type: 'copy_code', // Changed from 'url' to 'copy_code'
                        index: '0',
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

        this.logger.log(
            JSON.stringify({
                event: 'whatsapp_meta_send_started',
                apiVersion,
                phoneNumberId,
                recipient: this.maskPhone(phone),
                recipientDigitsLength: recipient.length,
                templateName,
                language,
                componentTypes: payload.template.components.map(component => component.type),
                bodyParameterCount: payload.template.components[0].parameters.length,
                buttonParameterCount: payload.template.components[1].parameters.length,
                buttonSubType: payload.template.components[1].sub_type,
                buttonIndex: payload.template.components[1].index,
            }),
        );

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10000),
            });

            const responseText = await response.text();
            let responseData: any = {};

            try {
                responseData = JSON.parse(responseText);
            } catch {
                this.logger.warn(
                    JSON.stringify({
                        event: 'whatsapp_meta_response_not_json',
                        status: response.status,
                        contentType: response.headers.get('content-type'),
                        responseLength: responseText.length,
                    }),
                );
            }

            this.logger.log(
                JSON.stringify({
                    event: 'whatsapp_meta_send_response',
                    status: response.status,
                    ok: response.ok,
                    durationMs: Date.now() - startedAt,
                    contentType: response.headers.get('content-type'),
                    responseLength: responseText.length,
                    hasMessageId: Boolean(responseData.messages?.[0]?.id),
                    metaErrorCode: responseData.error?.code,
                    metaErrorType: responseData.error?.type,
                    metaTraceId: responseData.error?.fbtrace_id,
                }),
            );

            if (!response.ok) {
                const metaError = responseData.error;
                const details = [
                    metaError?.message,
                    metaError?.error_data?.details,
                ]
                    .filter(Boolean)
                    .join(' | ');
                const error = new Error(details || `Meta API returned ${response.status}`);
                Object.assign(error, {
                    meta: {
                        status: response.status,
                        type: metaError?.type,
                        code: metaError?.code,
                        subcode: metaError?.error_subcode,
                        traceId: metaError?.fbtrace_id,
                        details: metaError?.error_data?.details,
                        templateName,
                        language,
                        phoneNumberId,
                        recipient: this.maskPhone(phone),
                        recipientDigitsLength: recipient.length,
                        durationMs: Date.now() - startedAt,
                    },
                });
                throw error;
            }

            return {
                success: true,
                messageId: responseData.messages?.[0]?.id,
            };
        } catch (error: unknown) {
            this.logger.error(
                JSON.stringify({
                    event: 'whatsapp_meta_send_failed',
                    durationMs: Date.now() - startedAt,
                    recipient: this.maskPhone(phone),
                    templateName,
                    language,
                    error: error instanceof Error ? error.message : 'Unknown error',
                }),
            );

            if (error instanceof Error && 'meta' in error) {
                this.logger.error(
                    JSON.stringify({
                        event: 'whatsapp_meta_api_error',
                        ...(error as any).meta,
                    }),
                );
            }

            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown WhatsApp API error',
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

    isValidWebhookSignature(request: Request & { rawBody?: Buffer }): boolean {
        const appSecret = process.env.WHATSAPP_APP_SECRET?.trim();
        const signature = request.header('x-hub-signature-256') || '';
        const rawBody = request.rawBody;

        if (!appSecret || !rawBody || !signature.startsWith('sha256=')) {
            return false;
        }

        const expected = createHmac('sha256', appSecret)
            .update(rawBody)
            .digest('hex');
        const provided = Buffer.from(signature.slice('sha256='.length), 'hex');
        const expectedBuffer = Buffer.from(expected, 'hex');

        return provided.length === expectedBuffer.length &&
            timingSafeEqual(provided, expectedBuffer);
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

    private getOtpReference(phone: string) {
        const key = createHash('sha256').update(phone).digest('hex');
        return this.firebaseAdmin.db().collection('whatsapp_otp_challenges').doc(key);
    }

    private readOtpRecord(data: DocumentData | undefined): WhatsappOtpRecord {
        if (!data) {
            throw new BadRequestException('No active verification code found.');
        }

        return {
            id: String(data.id),
            phone: String(data.phone),
            codeHash: String(data.codeHash),
            expiresAt: data.expiresAt.toDate(),
            attempts: Number(data.attempts),
            maxAttempts: Number(data.maxAttempts),
            used: Boolean(data.used),
            createdAt: data.createdAt.toDate(),
            lastSentAt: data.lastSentAt.toDate(),
            whatsappMessageId: data.whatsappMessageId
                ? String(data.whatsappMessageId)
                : undefined,
        };
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
        const value = process.env[key];

        if (!value) {
            return fallback;
        }

        const parsed = Number(value);

        return Number.isFinite(parsed)
            ? parsed
            : fallback;
    }
}