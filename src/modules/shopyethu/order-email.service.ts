import { Injectable } from '@nestjs/common';
import type { Order } from './marketplace.types';
import { escapeTemplateText, sendMarketplaceTemplateEmail } from './marketplace-template-email';

export type OrderConfirmation = {
  order: Order; recipientEmail: string; storeName: string; collectionArea: string;
};

function itemSummary(order: Order) {
  const lines: string[] = [];
  for (const item of order.items) {
    const name = item.name.replace(/\s+/g, ' ').trim();
    const line = escapeTemplateText(`${item.quantity} × ${name} — ${rand(item.quantity * item.priceCents)}`);
    // Hosted template string variables are limited to 2,000 characters.
    if ([...lines, line].join('\n').length > 1800) break;
    lines.push(line);
  }
  const remaining = order.items.length - lines.length;
  if (remaining) lines.push(`+ ${remaining} more ${remaining === 1 ? 'item' : 'items'}. View your full order in the app.`);
  return lines.join('\n');
}
const rand = (cents: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(cents / 100);

@Injectable()
export class OrderEmailService {
  async send({ order, recipientEmail, storeName, collectionArea }: OrderConfirmation): Promise<void> {
    if (order.status !== 'placed' || order.fulfilment !== 'collection' || order.paymentStatus !== 'not-collected') {
      throw new Error('Order confirmation requires a newly placed collection order.');
    }
    const placedAt = new Date(order.createdAt);
    await sendMarketplaceTemplateEmail({
      to: recipientEmail, subject: `Order ${order.reference} confirmed · ShopYethu`,
      templateId: 'order-confirmation',
      idempotencyKey: `shopyethu-order-confirmation/${order.id}`,
      failureLabel: 'Order confirmation email',
      variables: {
        ORDER_CODE: escapeTemplateText(order.reference), ORDER_ID: escapeTemplateText(order.id),
        STORE_NAME: escapeTemplateText(storeName), COLLECTION_AREA: escapeTemplateText(collectionArea),
        ITEMS_SUMMARY: itemSummary(order), ORDER_TOTAL: escapeTemplateText(rand(order.totalCents)),
        PLACED_AT: placedAt.toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' }),
        YEAR: placedAt.getUTCFullYear().toString(),
      },
    });
  }
}
