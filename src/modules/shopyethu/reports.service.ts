import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Actor, MarketplaceRepository, Order, Product, Report } from './marketplace.types';
import { exists, text } from './marketplace.validation';

export class ReportsService {
  constructor(private readonly repo: MarketplaceRepository) {}
  async submit(actor: Actor, body: Record<string, unknown>) {
    const message = text(body.message, 'Report details', 10, 3000);
    if (Boolean(body.productId) === Boolean(body.orderId)) throw new BadRequestException('Choose one listing or order to report.');
    const productId = typeof body.productId === 'string' ? text(body.productId, 'Listing', 1, 120) : undefined;
    const orderId = typeof body.orderId === 'string' ? text(body.orderId, 'Order', 1, 120) : undefined;
    return this.repo.transaction(async tx => {
      if (productId) exists(await tx.get<Product>('products', productId), 'Listing');
      if (orderId) {
        const order = exists(await tx.get<Order>('orders', orderId), 'Order');
        if (order.buyerUid !== actor.uid && order.sellerUid !== actor.uid) throw new ForbiddenException('You can only report an issue with your own order.');
      }
      const report: Report = { id: randomUUID(), reporterUid: actor.uid, message, status: 'open', createdAt: new Date().toISOString(), ...(productId ? { productId } : {}), ...(orderId ? { orderId } : {}) };
      tx.set('reports', report.id, report); return report;
    });
  }
}
