import { BadRequestException, HttpException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Twilio } from 'twilio';
import { phoneLimit } from './phone-verification.policy';

export interface VerificationProvider {
  assertConfigured(): void;
    start(phone: string): Promise<string>;
    check(sid: string, phone: string, code: string): Promise<boolean>;
}

@Injectable()
export class TwilioVerificationProvider implements VerificationProvider {
    private readonly logger = new Logger(TwilioVerificationProvider.name);
    private client?: Twilio;
    private serviceSid = '';
    constructor(private readonly config: ConfigService) { }
    private service() {
        if (!this.client) {
            const account = this.config.get<string>('TWILIO_ACCOUNT_SID') || '';
            const service = this.config.get<string>('TWILIO_VERIFY_SERVICE_SID') || '';
            const apiKey = this.config.get<string>('TWILIO_API_KEY_SID') || '';
            const apiSecret = this.config.get<string>('TWILIO_API_KEY_SECRET') || '';
            const authToken = this.config.get<string>('TWILIO_AUTH_TOKEN') || '';
            if (!/^AC[a-f\d]{32}$/i.test(account) || !/^VA[a-f\d]{32}$/i.test(service) ||
                (apiKey ? !/^SK[a-f\d]{32}$/i.test(apiKey) || !apiSecret : !authToken)) {
                throw new ServiceUnavailableException('Phone verification is not configured.');
            }
            this.client = new Twilio(apiKey || account, apiKey ? apiSecret : authToken, { accountSid: account, timeout: 8000, autoRetry: false, keepAlive: true });
            this.serviceSid = service;
        }
        return this.client.verify.v2.services(this.serviceSid);
    }
  assertConfigured() { this.service(); }
    async start(phone: string) {
        try {
            const verification = await this.service().verifications.create({ to: phone, channel: 'sms', riskCheck: 'enable' });
            if (!/^VE[a-f\d]{32}$/i.test(verification.sid) || verification.to !== phone || verification.status !== 'pending') throw new Error('Unexpected verification response.');
            return verification.sid;
        } catch (cause) { throw this.failure(cause, 'send'); }
    }
    async check(sid: string, phone: string, code: string) {
        try {
            const result = await this.service().verificationChecks.create({ verificationSid: sid, code });
            if (result.to !== phone || result.sid !== sid || result.serviceSid !== this.serviceSid) throw new Error('Verification response did not match the challenge.');
            return result.status === 'approved' && result.valid === true;
        } catch (cause) { throw this.failure(cause, 'check'); }
    }
    private failure(cause: unknown, operation: string) {
        if (cause instanceof HttpException) return cause;
        const failure = cause && typeof cause === 'object' ? cause as { code?: unknown; status?: unknown } : {};
        const code = typeof failure.code === 'number' ? failure.code : undefined;
        const status = typeof failure.status === 'number' ? failure.status : undefined;
        // Never log provider messages, request bodies, OTPs, phone numbers or credentials.
        this.logger.warn(JSON.stringify({ event: 'phone_verification_provider_error', operation, code, status }));
        if (code === 20404) return new BadRequestException('That code has expired or was already used. Request a new code.');
        if (code === 60200 || code === 21211) return new BadRequestException('Enter a valid phone number.');
        if (code === 60202 || code === 60203) return phoneLimit(600);
        if (status === 429) return phoneLimit(60);
        return new ServiceUnavailableException(operation === 'send' ? 'We could not send the code. Please try again later.' : 'We could not check the code. Please try again later.');
    }
}
