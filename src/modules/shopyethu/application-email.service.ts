import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { SellerApplication } from './marketplace.types';
import { escapeTemplateText as escapeText, sendMarketplaceTemplateEmail } from './marketplace-template-email';

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
        const approved = event === 'approved';
        const templateId = approved ? 'seller-account-approval' : 'seller-application-received';
        const idempotencyKey = `shopyethu-application-${event}/${createHash('sha256')
            .update(`${application.id}:${application.updatedAt}:${application.history?.length || 1}`).digest('hex')}`;
        const submittedAt = new Date(application.updatedAt);
        await sendMarketplaceTemplateEmail({
            to: application.email,
            subject: approved ? 'Your ShopYethu seller application is approved' : 'We received your ShopYethu seller application',
            templateId, idempotencyKey, failureLabel: 'Application confirmation email',
            variables: {
                CONTACT_NAME: escapeText(application.contactName),
                BUSINESS_NAME: escapeText(application.businessName),
                [approved ? 'APPROVED_AT' : 'SUBMITTED_AT']: submittedAt.toLocaleString('en-ZA', {
                    timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short',
                }),
                YEAR: submittedAt.getUTCFullYear().toString(),
            },
        });
    }
}
