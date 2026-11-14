import { BadRequestException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isPhoneNumber } from 'class-validator';
import { RuntimeLimitService } from '../../common/runtime-limit.service';

export const PHONE_TTL_MS = 10 * 60_000;
export const PHONE_LEASE_MS = 20_000;
export const PHONE_MAX_CHECKS = 5;
export function phoneLimit(seconds: number) {
    return new HttpException({ message: 'Too many attempts. Please wait before trying again.', retryAfterSeconds: Math.max(1, Math.ceil(seconds)) }, 429);
}
@Injectable()
export class PhoneVerificationPolicy {
    constructor(private readonly config: ConfigService, private readonly limits: RuntimeLimitService) { }
    assertEnabled() {
        if (this.config.get('PHONE_VERIFICATION_ENABLED') !== 'true') throw new ServiceUnavailableException('Phone verification is not available.');
        if (this.config.get('NODE_ENV') === 'production' && !['redis', 'firestore'].includes(this.config.get('RUNTIME_LIMIT_STORE') || '')) {
            throw new ServiceUnavailableException('Phone verification security checks are not configured.');
        }
    }
    normalise(input: unknown) {
        if (typeof input !== 'string' || input.length > 32 || !/^\+?[\d\s()-]+$/.test(input)) throw new BadRequestException('Enter a valid phone number.');
        const cleaned = input.replace(/[\s()-]/g, '');
        if (cleaned.startsWith('0') && !/^0[1-9]\d{8}$/.test(cleaned)) throw new BadRequestException('Enter a complete South African phone number.');
        const phone = cleaned.startsWith('0') ? `+27${cleaned.slice(1)}` : cleaned;
        const countries = String(this.config.get('PHONE_VERIFICATION_ALLOWED_COUNTRIES') || 'ZA').split(',').map(value => value.trim().toUpperCase());
        if (!/^\+[1-9]\d{7,14}$/.test(phone) || !countries.some(country => /^[A-Z]{2}$/.test(country) && isPhoneNumber(phone, country as Parameters<typeof isPhoneNumber>[1]))) {
            throw new BadRequestException('Enter a valid phone number in a supported country.');
        }
        return phone;
    }
    private async reserve(key: string, limit: number, windowMs: number) {
        const result = await this.limits.reserve({ collection: 'runtime_phone_verification_limits', key, limit, windowMs });
        if (result.limited) throw phoneLimit(result.retryAfterSeconds);
    }
    async send(uid: string, phone: string, ip: string) {
        const configured = Number(this.config.get('PHONE_VERIFICATION_DAILY_SEND_LIMIT') || 100);
        if (!Number.isSafeInteger(configured) || configured < 1 || configured > 10000) throw new ServiceUnavailableException('Phone verification is not configured.');
        // Shared counters run before the provider call. Failed sends still spend budget.
        await this.reserve(`send:uid:${uid}`, 5, 60 * 60_000);
        await this.reserve(`send:ip:${ip}`, 20, 60 * 60_000);
        await this.reserve(`send:phone:${phone}`, 5, 60 * 60_000);
        await this.reserve('send:global', configured, 24 * 60 * 60_000);
        await this.reserve(`send:uid-cooldown:${uid}`, 1, 30_000);
        await this.reserve(`send:phone-cooldown:${phone}`, 1, 30_000);
    }
    async check(uid: string, ip: string) {
        await this.reserve(`check:uid:${uid}`, 10, 60_000);
        await this.reserve(`check:ip:${ip}`, 30, 60_000);
    }
}
