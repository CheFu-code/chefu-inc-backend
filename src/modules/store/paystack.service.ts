import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

export class PaystackError extends ServiceUnavailableException {
    constructor(readonly outcome: 'TIMEOUT' | 'UNAVAILABLE' | 'NOT_FOUND' | 'INVALID_RESPONSE' | 'RATE_LIMITED', readonly retryAfterMs = 30_000) {
        super('Payment confirmation is pending. Please check its status again.');
    }
}

export type PaystackTransaction = {
    id: string | number; domain: 'test' | 'live';
    reference: string; status: string; amount: number; currency: string;
    customer?: { email?: string }; metadata?: { orderId?: string; paymentAttemptId?: string };
};

@Injectable()
export class PaystackService {
    assertConfigured() {
        if (!/^sk_(test|live)_[a-zA-Z0-9]+$/.test(process.env.PAYSTACK_SECRET_KEY ?? '')) throw new ServiceUnavailableException('Store payments are not configured.');
    }

    private async request(path: string, body?: unknown) {
        this.assertConfigured();
        // Only reads are retried. Initialization is non-idempotent at the gateway.
        const attempts = body ? 1 : 3;
        for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const response = await fetch(`https://api.paystack.co${path}`, {
                method: body ? 'POST' : 'GET',
                headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
                ...(body ? { body: JSON.stringify(body) } : {}),
                redirect: 'error',
                signal: AbortSignal.timeout(5_000),
            });
            if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
                const retryAfter = Number(response.headers.get('retry-after') || 0) * 1000;
                // Defer long provider cooldowns to durable reconciliation.
                if (retryAfter > 1000) throw new PaystackError('RATE_LIMITED', Math.min(retryAfter, 24 * 60 * 60_000));
                await new Promise(resolve => setTimeout(resolve, Math.max(retryAfter, 150 * 2 ** attempt + Math.random() * 100)));
                continue;
            }
            // Preserve unsigned 64-bit IDs before JSON.parse can round them.
            const raw = await response.text();
            const result = JSON.parse(raw.replace(/("id"\s*:\s*)(\d{16,})(?=\s*[,}])/g, '$1"$2"')) as { status?: boolean; data?: unknown };
            if (response.status === 429) throw new PaystackError('RATE_LIMITED');
            if (response.status === 404 || (!body && response.status === 400)) throw new PaystackError('NOT_FOUND');
            if (!response.ok) throw new PaystackError('UNAVAILABLE');
            if (result.status !== true || !result.data) throw new PaystackError('INVALID_RESPONSE');
            return result.data;
        } catch (error) {
            if (!body && attempt + 1 < attempts && (error instanceof TypeError || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)))) {
                await new Promise(resolve => setTimeout(resolve, 150 * 2 ** attempt + Math.random() * 100));
                continue;
            }
            // A timeout does not establish that Paystack failed to create/charge a transaction.
            if (error instanceof PaystackError) throw error;
            throw new PaystackError(error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'TIMEOUT' : 'UNAVAILABLE');
        }
        }
        throw new ServiceUnavailableException('Payment verification is pending.');
    }

    async initialize(order: { reference: string; amountMinor: number; delivery: Record<string, string> }) {
        const result = await this.request('/transaction/initialize', {
            reference: order.reference, amount: order.amountMinor, currency: 'ZAR',
            email: order.delivery.email, metadata: { orderId: order.reference, paymentAttemptId: order.reference },
        }) as { reference?: string; access_code?: string };
        if (result.reference !== order.reference || !result.access_code || !/^[a-zA-Z0-9_-]{1,256}$/.test(result.access_code)) throw new ServiceUnavailableException('Invalid payment provider response.');
        return result.access_code;
    }

    async verify(reference: string): Promise<PaystackTransaction> {
        return await this.request(`/transaction/verify/${encodeURIComponent(reference)}`) as PaystackTransaction;
    }

    authenticateWebhook(rawBody: Buffer | undefined, signature?: string, legacySignature?: string) {
        this.assertConfigured();
        if (!rawBody) throw new UnauthorizedException('Missing webhook body.');
        const matches = (expected: Buffer, value: string) => /^[a-f0-9]{128}$/.test(value) && timingSafeEqual(expected, Buffer.from(value, 'hex'));
        const webhookSecret = process.env.PAYSTACK_WEBHOOK_SECRET;
        // Configuring the current signing secret disables legacy fallback (no downgrade).
        if (webhookSecret) {
            const parts = (signature ?? '').split(',').map(part => part.trim());
            const timestamp = parts.find(part => part.startsWith('t='))?.slice(2) ?? '';
            if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new UnauthorizedException('Invalid webhook timestamp.');
            const expected = createHmac('sha512', webhookSecret).update(`${timestamp}.`).update(rawBody).digest();
            if (parts.some(part => part.startsWith('v1=') && matches(expected, part.slice(part.indexOf(':') + 1)))) return;
        } else {
            const expected = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!).update(rawBody).digest();
            if (matches(expected, legacySignature ?? '')) return;
        }
        throw new UnauthorizedException('Invalid webhook signature.');
    }
}
