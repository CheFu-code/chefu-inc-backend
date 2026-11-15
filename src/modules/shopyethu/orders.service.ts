import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { Actor, Fulfilment, MarketplaceConfig, MarketplaceRepository, Order, OrderStatus, Product, Storefront } from './marketplace.types';
import { exists, integer, seller, text } from './marketplace.validation';

type BasketItem = { productId: string; quantity: number; expectedPriceCents: number };
const transitions: Record<OrderStatus, OrderStatus[]> = {
  placed: ['accepted', 'cancelled'], accepted: ['preparing', 'cancelled'], preparing: ['ready', 'dispatched'],
  ready: ['collected'], dispatched: ['completed'], completed: [], collected: [], cancelled: [],
};

export class OrdersService {
  constructor(private readonly repo: MarketplaceRepository, private readonly config: MarketplaceConfig) {}
  async list(actor: Actor, selling = false) {
    if (selling) await seller(this.repo, actor);
    return (await this.repo.list<Order>('orders', [[selling ? 'sellerUid' : 'buyerUid', actor.uid]])).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async place(actor: Actor, body: Record<string, unknown>, rawKey: unknown) {
    const key = text(rawKey, 'Idempotency key', 16, 120);
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 30) throw new BadRequestException('Your basket must have 1–30 items.');
    const items: BasketItem[] = body.items.map(item => {
      if (!item || typeof item !== 'object') throw new BadRequestException('Invalid basket item.');
      return { productId: text(item.productId, 'Product', 1, 120), quantity: integer(item.quantity, 'Quantity', 1, 99), expectedPriceCents: integer(item.expectedPriceCents, 'Expected price', 1, 100000000) };
    }).sort((a, b) => a.productId.localeCompare(b.productId));
    if (new Set(items.map(item => item.productId)).size !== items.length) throw new BadRequestException('Combine duplicate basket items.');
    const fulfilment = body.fulfilment as Fulfilment;
    if (fulfilment !== 'collection') throw new BadRequestException('This fulfilment option is not configured.');
    const contact = text(body.contact, 'Contact details', 5, 200);
    const address = text(body.address ?? '', 'Collection instructions', 0, 500);
    const signature = createHash('sha256').update(JSON.stringify({ items, fulfilment, contact, address })).digest('hex');
    const reservation = createHash('sha256').update(`${actor.uid}:${key}`).digest('hex');
    return this.repo.transaction(async tx => {
      const previous = await tx.get<{ signature: string; orderId: string }>('idempotency', reservation);
      if (previous) {
        if (previous.signature !== signature) throw new ConflictException('This order attempt was already used for different basket details.');
        return exists(await tx.get<Order>('orders', previous.orderId), 'Order');
      }
      if (!this.config.collectionEnabled) throw new ServiceUnavailableException('Marketplace payment and fulfilment rules are not configured. Ordering is unavailable.');
      const products = await Promise.all(items.map(item => tx.get<Product>('products', item.productId)));
      const storeId = products[0]?.storeId;
      const store = storeId ? await tx.get<Storefront>('stores', storeId) : null;
      if (!store || store.status !== 'active') throw new ConflictException('This seller is unavailable. Review your basket.');
      const snapshots = items.map((item, index) => {
        const product = products[index];
        if (!product || !product.published || product.storeId !== storeId) throw new ConflictException('Only available products from one store can be ordered together.');
        if (!product.fulfilment.includes(fulfilment)) throw new ConflictException(`${product.name} does not support this fulfilment option.`);
        if (product.priceCents !== item.expectedPriceCents) throw new ConflictException(`${product.name}'s price changed. Refresh your basket before ordering.`);
        if (product.stock < item.quantity) throw new ConflictException(`${product.name} has only ${product.stock} available. Review your basket.`);
        return { productId: product.id, name: product.name, quantity: item.quantity, priceCents: product.priceCents, photo: product.photos[0] || '' };
      });
      const now = new Date().toISOString();
      const orderId = randomUUID();
      const subtotalCents = snapshots.reduce((total, item) => total + item.quantity * item.priceCents, 0);
      const deliveryCents = 0;
      const order: Order = {
        id: orderId, reference: `SY-${orderId.slice(0, 8).toUpperCase()}`, buyerUid: actor.uid,
        sellerUid: store.ownerUid, storeId: store.id, items: snapshots, subtotalCents, deliveryCents,
        totalCents: subtotalCents + deliveryCents, fulfilment, address, contact, status: 'placed',
        paymentStatus: 'not-collected', paymentNote: 'Payment due on collection; no online payment has been collected.',
        createdAt: now, updatedAt: now, history: [{ status: 'placed', at: now }],
      };
      products.forEach((product, index) => tx.set('products', product!.id, { ...product, stock: product!.stock - items[index].quantity }));
      tx.set('orders', orderId, order);
      tx.set('idempotency', reservation, { orderId, signature });
      return order;
    });
  }
  async update(actor: Actor, orderId: string, next: unknown) {
    return this.repo.transaction(async tx => {
      await seller(tx, actor);
      const order = exists(await tx.get<Order>('orders', orderId), 'Order');
      if (order.sellerUid !== actor.uid) throw new ForbiddenException('This order belongs to another store.');
      const status = next as OrderStatus;
      if (!transitions[order.status].includes(status)) throw new BadRequestException('This status change is not allowed.');
      if ((status === 'dispatched' && order.fulfilment !== 'local-delivery') || (status === 'ready' && order.fulfilment !== 'collection')) throw new BadRequestException('Choose the status matching this order’s fulfilment.');
      if (status === 'collected' && (order.fulfilment !== 'collection' || order.paymentStatus !== 'paid-on-collection')) throw new BadRequestException('Confirm payment before marking this order collected.');
      const restock = status === 'cancelled' ? await Promise.all(order.items.map(item => tx.get<Product>('products', item.productId))) : [];
      restock.forEach((product, index) => { if (product) tx.set('products', product.id, { ...product, stock: product.stock + order.items[index].quantity }); });
      const now = new Date().toISOString();
      const updated = { ...order, status, updatedAt: now, history: [...order.history, { status, at: now }] };
      tx.set('orders', orderId, updated); return updated;
    });
  }
  async confirmPayment(actor: Actor, orderId: string) {
    return this.repo.transaction(async tx => {
      await seller(tx, actor);
      const order = exists(await tx.get<Order>('orders', orderId), 'Order');
      if (order.sellerUid !== actor.uid) throw new ForbiddenException('This order belongs to another store.');
      if (order.fulfilment !== 'collection') throw new BadRequestException('Payment confirmation is only available for collection orders.');
      if (order.paymentStatus === 'paid-on-collection') return order;
      if (order.status !== 'ready') throw new ConflictException('Payment can only be confirmed when the order is ready for collection.');
      const now = new Date().toISOString();
      const updated: Order = {
        ...order,
        paymentStatus: 'paid-on-collection',
        paymentNote: 'The seller confirmed payment was received at collection.',
        paymentReceivedAt: now,
        paymentReceivedBy: actor.uid,
        updatedAt: now,
      };
      tx.set('orders', orderId, updated);
      return updated;
    });
  }
}
