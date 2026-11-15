import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assertResendConfigured } from '../../common/env';
import type { SellerApplication } from './marketplace.types';

// Variables are inserted into HTML text nodes by the hosted template.
const escapeText = (value: string) => value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);

@Injectable()
export class ApplicationEmailService {
    async send(application: SellerApplication): Promise<void> {
        return this.sendNotification(application, 'received');
    }

    async sendApproval(application: SellerApplication): Promise<void> {
        if (application.status !== 'approved') throw new Error('An approval email requires a saved approval.');
        return this.sendNotification(application, 'approved');
    }

    private async sendNotification(application: SellerApplication, event: 'received' | 'approved'): Promise<void> {
        assertResendConfigured();
        const approved = event === 'approved';
        const templateId = approved ? 'seller-account-approval' : 'seller-application-received';
        const idempotencyKey = `shopyethu-application-${event}/${createHash('sha256')
            .update(`${application.id}:${application.updatedAt}:${application.history?.length || 1}`).digest('hex')}`;
        const submittedAt = new Date(application.updatedAt);
        const body = JSON.stringify({
            from: 'ShopYethu <notifications@chefu.co.za>',
            to: [application.email],
            subject: approved ? 'Your ShopYethu seller application is approved' : 'We received your ShopYethu seller application',
            template: {
                id: templateId,
                variables: {
                    CONTACT_NAME: escapeText(application.contactName),
                    BUSINESS_NAME: escapeText(application.businessName),
                    [approved ? 'APPROVED_AT' : 'SUBMITTED_AT']: submittedAt.toLocaleString('en-ZA', {
                        timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short',
                    }),
                    YEAR: submittedAt.getUTCFullYear().toString(),
                },
            },
        });
        // Bounded retries share an identical body and Resend idempotency key.
        for (let attempt = 0; attempt < 2; attempt++) {
            let response: Response;
            try {
                response = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${(process.env.RESEND_API_KEY || '').trim()}`,
                        'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey,
                    },
                    body, signal: AbortSignal.timeout(3000),
                });
            } catch {
                if (attempt === 0) { await delay(250); continue; }
                throw new Error('Application confirmation email could not reach Resend.');
            }
            if (response.ok) { await response.body?.cancel(); return; }
            await response.body?.cancel();
            // Do not retry configuration/validation failures or ignore provider backoff.
            if (attempt === 0 && response.status >= 500) { await delay(250); continue; }
            throw new Error(`Application confirmation email failed (HTTP ${response.status}).`);
        }
    }
}
