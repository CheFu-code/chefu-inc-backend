import { ConflictException, HttpException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Transaction } from 'firebase-admin/firestore';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { ProductsService } from '../products/products.service';
import type { ProductDocument } from '../products/products.types';
import { CheckoutInput, OrderLine, identifier, validateCheckout, priceOrder } from './checkout.validation';
import { PaystackError, PaystackService, PaystackTransaction } from './paystack.service';
import { digest, PaymentRecord, paymentFromOrder, providerIdentity, StoreOrder, transitionPayment } from './payment.model';
import { StoreJob, StoreJobsService } from './store-jobs.service';
export type { StoreOrder } from './payment.model';

@Injectable()
export class CheckoutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CheckoutService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    @Inject(FirebaseAdminService) private readonly firebase: FirebaseAdminService,
    @Inject(PaystackService) private readonly paystack: PaystackService,
    @Inject(ProductsService) private readonly products: ProductsService,
    @Inject(StoreJobsService) private readonly jobs: StoreJobsService,
  ) {}
  onModuleInit() {
    if (!process.env.PAYSTACK_SECRET_KEY || process.env.STORE_RECONCILIATION_ENABLED === 'false') return;
    this.timer = setInterval(() => { void this.reconcile().catch(() => this.log('worker_unavailable')); }, 15_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  private get db() { return this.firebase.db(); }
  private log(event: string, reference?: string) { this.logger.log(JSON.stringify({ event: `store_${event}`, ...(reference ? { reference } : {}) })); }
  private audit(tx: Transaction, reference: string, action: string, details: Record<string, unknown> = {}) {
    tx.create(this.db.collection('storePaymentAudit').doc(randomUUID()), { reference, action, ...details, createdAt: Date.now() });
  }
  private alert(tx: Transaction, reference: string, type: string) {
    tx.set(this.db.collection('storeAlerts').doc(digest(`${type}:${reference}`)), { reference, type, resolved: false, createdAt: Date.now() });
    this.log(type, reference);
  }

  async initialize(uid: string, key: string, body: unknown) {
    if (process.env.STORE_CHECKOUT_ENABLED === 'false') throw new ServiceUnavailableException('New checkouts are disabled.');
    this.paystack.assertConfigured();
    identifier(key);
    const input = validateCheckout(body);
    const ownerHash = digest(`account:${uid}`);
    const requestHash = digest(JSON.stringify(input));
    const keyRef = this.db.collection('storeCheckoutKeys').doc(digest(`${ownerHash}:initialize:${key}`));
    const accountRef = this.db.collection('storeCheckoutAccounts').doc(digest(uid));
    const reference = `store-${randomUUID()}`;
    const now = Date.now();
    const result = await this.db.runTransaction(async tx => {
      const existingKey = await tx.get(keyRef);
      const account = (await tx.get(accountRef)).data();
      const existingReference = existingKey.data()?.reference || account?.activeReference;
      if (existingReference) {
        const order = (await tx.get(this.db.collection('storeOrders').doc(existingReference))).data() as StoreOrder;
        if (!order || order.accountUid !== uid || order.requestHash !== requestHash) throw new ConflictException({ code: 'ACTIVE_CHECKOUT', message: 'Recover your saved checkout before creating another order.' });
        if (!existingKey.exists) tx.create(keyRef, { reference: existingReference, createdAt: now });
        return { order, created: false };
      }
      const date = new Date(now).toISOString().slice(0, 10);
      const count = account?.quotaDate === date ? Number(account.creations || 0) : 0;
      if (count >= 10) throw new HttpException('Checkout creation limit reached. Contact support if you need help.', 429);
      const products = await this.readProducts(tx, input.items);
      const priced = priceOrder(input.items, products);
      const order: StoreOrder = { ...priced, reference, ownerHash, accountUid: uid, requestHash, delivery: input.delivery, status: 'initializing', stockReserved: true, initLeaseUntil: 0, createdAt: now, updatedAt: now, reconcileAfter: now + 60_000, termsAcceptedAt: now, schemaVersion: 2 };
      const payment: PaymentRecord = { ...paymentFromOrder(order), state: 'PENDING', initializationDispatched: true };
      this.changeStock(tx, products, order.lines, -1);
      tx.create(this.db.collection('storeOrders').doc(reference), order);
      tx.create(this.db.collection('storePayments').doc(reference), payment);
      tx.create(keyRef, { reference, createdAt: now });
      tx.set(accountRef, { activeReference: reference, latestReference: reference, quotaDate: date, creations: count + 1 });
      this.jobs.enqueue(tx, `verify-${reference}`, 'verify', reference, 60_000);
      this.audit(tx, reference, 'CHECKOUT_CREATED', { actorHash: digest(uid) });
      return { order, created: true };
    });
    if (!result.created) { this.log('checkout_replayed', result.order.reference); return this.session(result.order); }
    this.products.invalidateProductsCache();
    // Dispatch this POST only once. A lost response never authorizes a second POST.
    let accessCode: string;
    try { accessCode = await this.paystack.initialize(result.order); }
    catch {
      this.log('initialization_unknown', reference);
      throw new ServiceUnavailableException({ code: 'CHECKOUT_PENDING', message: 'Your order is saved. Recover its status before paying again.' });
    }
    await this.db.runTransaction(async tx => {
      const orderRef = this.db.collection('storeOrders').doc(reference);
      const paymentRef = this.db.collection('storePayments').doc(reference);
      const order = (await tx.get(orderRef)).data() as StoreOrder;
      const payment = (await tx.get(paymentRef)).data() as PaymentRecord;
      const updated = payment.state === 'PENDING' ? transitionPayment(payment, 'INITIALIZED') : payment;
      tx.update(paymentRef, { ...updated, accessCode });
      tx.update(orderRef, { accessCode, ...(order.status === 'initializing' ? { status: 'pending' } : {}), updatedAt: Date.now() });
      this.audit(tx, reference, 'INITIALIZED');
    });
    this.log('initialized', reference);
    return this.session({ ...result.order, accessCode });
  }
  private owns(order: StoreOrder, uid?: string, guest?: string) {
    return Boolean((uid && order.accountUid === uid) || (!order.accountUid && guest && order.ownerHash === digest(guest)));
  }
  async verify(uid: string | undefined, reference: string, guest?: string) {
    identifier(reference);
    const order = (await this.db.collection('storeOrders').doc(reference).get()).data() as StoreOrder | undefined;
    if (!order || !this.owns(order, uid, guest)) throw new NotFoundException('Order was not found.');
    return this.verification(order.status === 'paid' ? order : await this.refresh(reference));
  }
  async recover(uid: string) {
    const account = (await this.db.collection('storeCheckoutAccounts').doc(digest(uid)).get()).data();
    if (!account?.activeReference) return { checkout: null };
    const order = (await this.db.collection('storeOrders').doc(account.activeReference).get()).data() as StoreOrder;
    if (!order || order.accountUid !== uid) throw new NotFoundException('Order was not found.');
    const payment = (await this.db.collection('storePayments').doc(order.reference).get()).data() as PaymentRecord | undefined;
    return { checkout: {
      ...this.verification(order), subtotalMinor: order.subtotalMinor, deliveryMinor: order.deliveryMinor,
      paymentState: payment?.state ?? paymentFromOrder(order).state,
      items: order.lines.map(({ productId, variantId, quantity }) => ({ productId, ...(variantId ? { variantId } : {}), quantity })),
      ...(order.accessCode && !['paid', 'failed'].includes(order.status) && payment?.state !== 'EXPIRED' && payment?.state !== 'REQUIRES_REVIEW' ? { accessCode: order.accessCode } : {}),
    } };
  }
  async history(uid: string) {
    const orders = await this.db.collection('storeOrders').where('accountUid', '==', uid).orderBy('createdAt', 'desc').limit(20).get();
    return { orders: orders.docs.map(doc => this.verification(doc.data() as StoreOrder)) };
  }
  async acknowledge(uid: string, reference: string) {
    return this.db.runTransaction(async tx => {
      const order = (await tx.get(this.db.collection('storeOrders').doc(reference))).data() as StoreOrder;
      const accountRef = this.db.collection('storeCheckoutAccounts').doc(digest(uid));
      const account = (await tx.get(accountRef)).data();
      if (!order || order.accountUid !== uid) throw new NotFoundException('Order was not found.');
      if (!['paid', 'failed'].includes(order.status)) throw new ConflictException('Payment is still unresolved.');
      if (account?.activeReference === reference) tx.update(accountRef, { activeReference: '' });
      this.audit(tx, reference, 'CUSTOMER_ACKNOWLEDGED', { actorHash: digest(uid) });
      return { acknowledged: true };
    });
  }
  async claimLegacy(uid: string, reference: string, guest: string) {
    await this.db.runTransaction(async tx => {
      const ref = this.db.collection('storeOrders').doc(reference);
      const order = (await tx.get(ref)).data() as StoreOrder;
      const accountRef = this.db.collection('storeCheckoutAccounts').doc(digest(uid));
      const account = (await tx.get(accountRef)).data();
      if (!order || (order.accountUid !== uid && (order.accountUid || order.ownerHash !== digest(guest)))) throw new NotFoundException('Order was not found.');
      if (account?.activeReference && account.activeReference !== reference) throw new ConflictException('An account checkout is already active.');
      tx.update(ref, { accountUid: uid });
      tx.set(accountRef, { ...account, activeReference: reference, latestReference: reference });
      this.audit(tx, reference, 'LEGACY_ORDER_CLAIMED', { actorHash: digest(uid) });
    });
    return this.recover(uid);
  }
  async webhook(body: unknown, eventId: string) {
    const event = body as { event?: unknown; data?: { reference?: unknown; transaction?: { reference?: unknown }; id?: unknown } } | null;
    if (typeof event?.event !== 'string') return { received: true };
    if (!(event.event === 'charge.success' || event.event.startsWith('refund.') || event.event.startsWith('charge.dispute.'))) return { received: true };
    const value = event.data?.reference ?? event.data?.transaction?.reference;
    const reference = typeof value === 'string' && /^[A-Za-z0-9_.=-]{1,128}$/.test(value) ? value : '';
    const eventRef = this.db.collection('storeWebhookEvents').doc(eventId);
    await this.db.runTransaction(async tx => {
      if ((await tx.get(eventRef)).exists) { this.log('webhook_duplicate', reference); return; }
      // Persist a minimal signed summary, never card/customer payloads.
      tx.create(eventRef, { type: event.event, reference, providerEventId: providerIdentity(event.data?.id) ?? '', receivedAt: Date.now(), state: 'queued' });
      this.jobs.enqueue(tx, `webhook-${eventId}`, 'webhook', reference, 0, eventId);
    });
    this.log('webhook_recorded', reference);
    return { received: true };
  }
  async refresh(reference: string): Promise<StoreOrder> {
    const ref = this.db.collection('storeOrders').doc(reference);
    const paymentRef = this.db.collection('storePayments').doc(reference);
    const lease = randomUUID();
    const claim = await this.db.runTransaction(async tx => {
      const order = (await tx.get(ref)).data() as StoreOrder;
      if (!order) throw new NotFoundException('Order was not found.');
      let payment = (await tx.get(paymentRef)).data() as PaymentRecord | undefined;
      payment ??= paymentFromOrder(order);
      if (order.status === 'paid' || payment.verificationLeaseUntil > Date.now() || payment.nextVerificationAt > Date.now()) return { order, claimed: false };
      if (!['SUCCESS', 'FAILED', 'EXPIRED', 'REQUIRES_REVIEW'].includes(payment.state) && payment.expiresAt <= Date.now()) payment = transitionPayment(payment, 'EXPIRED');
      tx.set(paymentRef, { ...payment, verificationLease: lease, verificationLeaseUntil: Date.now() + 45_000, verificationAttempts: payment.verificationAttempts + 1 });
      return { order, claimed: true };
    });
    if (!claim.claimed) return claim.order;
    try { return await this.applyPayment(reference, await this.paystack.verify(reference), lease); }
    catch (error) {
      await this.db.runTransaction(async tx => {
        const payment = (await tx.get(paymentRef)).data() as PaymentRecord;
        if (payment.verificationLease !== lease) return;
        const outcome = error instanceof PaystackError ? error.outcome : 'UNKNOWN';
        tx.update(paymentRef, { verificationLeaseUntil: 0, nextVerificationAt: Date.now() + (error instanceof PaystackError ? error.retryAfterMs : 30_000), lastOutcome: outcome, updatedAt: Date.now() });
        this.audit(tx, reference, `VERIFICATION_${outcome}`);
      });
      this.log('verification_unknown', reference);
      return (await ref.get()).data() as StoreOrder;
    }
  }
  async applyPayment(reference: string, provider: PaystackTransaction, lease?: string): Promise<StoreOrder> {
    const ref = this.db.collection('storeOrders').doc(reference);
    const paymentRef = this.db.collection('storePayments').doc(reference);
    const result = await this.db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data() as StoreOrder;
      if (!current) throw new NotFoundException('Order was not found.');
      const payment = (await tx.get(paymentRef)).data() as PaymentRecord | undefined ?? paymentFromOrder(current);
      if (lease && payment.verificationLease !== lease) return current;
      if (payment.state === 'SUCCESS' || current.status === 'paid') return current;
      const providerId = providerIdentity(provider?.id);
      const identityRef = providerId ? this.db.collection('storeProviderTransactions').doc(`paystack-${providerId}`) : null;
      const identity = identityRef ? (await tx.get(identityRef)).data() : undefined;
      const expectedMode = process.env.PAYSTACK_MODE ?? (process.env.PAYSTACK_SECRET_KEY?.startsWith('sk_live_') ? 'live' : 'test');
      const mismatch = !provider || provider.reference !== reference || provider.currency !== current.currency || provider.amount !== current.amountMinor || provider.customer?.email?.toLowerCase() !== current.delivery.email || provider.metadata?.orderId !== reference || (current.schemaVersion === 2 && provider.metadata?.paymentAttemptId !== reference) || !providerId || (payment.providerId && payment.providerId !== providerId) || (identity && identity.reference !== reference) || provider.domain !== expectedMode;
      const now = Date.now();
      if (mismatch) {
        tx.set(paymentRef, { ...transitionPayment(payment, 'REQUIRES_REVIEW'), verificationLeaseUntil: 0, nextVerificationAt: now + 60_000, lastOutcome: 'MISMATCH' });
        this.audit(tx, reference, 'PAYMENT_MISMATCH');
        this.alert(tx, reference, 'payment_mismatch');
        return current;
      }
      const state = provider.status === 'success' ? 'SUCCESS' : provider.status === 'failed' ? 'FAILED' : ['FAILED', 'EXPIRED', 'REQUIRES_REVIEW'].includes(payment.state) ? payment.state : 'PROCESSING';
      const updatedPayment = { ...transitionPayment(payment, state), providerId, verifiedAt: now, verificationLeaseUntil: 0, nextVerificationAt: now + 10_000, lastOutcome: state };
      let stockReserved = current.stockReserved;
      let stockReview = false;
      const products = (state === 'FAILED' && stockReserved) || (state === 'SUCCESS' && !stockReserved) ? await this.readProducts(tx, current.lines) : null;
      const fulfillmentRef = this.db.collection('storeFulfillments').doc(reference);
      const fulfillment = state === 'SUCCESS' ? await tx.get(fulfillmentRef) : null;
      if (products && state === 'FAILED') {
        const canRelease = current.lines.every(line => !line.stockTracking || this.stockTarget(products.get(line.productId), line) !== undefined);
        if (canRelease) { this.changeStock(tx, products, current.lines, 1); stockReserved = false; }
        else this.alert(tx, reference, 'stock_release_review');
      } else if (products && state === 'SUCCESS') {
        stockReview = current.lines.some(line => line.stockTracking && Number(this.stockTarget(products.get(line.productId), line)?.inventoryQuantity ?? -1) < line.quantity);
        if (!stockReview) { this.changeStock(tx, products, current.lines, -1); stockReserved = true; }
      }
      const status = state === 'SUCCESS' ? 'paid' : state === 'FAILED' ? 'failed' : 'pending';
      const updated: StoreOrder = { ...current, status, stockReserved, updatedAt: now, ...(state === 'SUCCESS' ? { paidAt: now, fulfillmentStatus: stockReview ? 'stock_review' : 'queued' } : {}) };
      tx.set(paymentRef, updatedPayment);
      if (identityRef && !identity) tx.create(identityRef, { reference, createdAt: now });
      tx.update(ref, updated);
      this.audit(tx, reference, `VERIFIED_${state}`, { providerId });
      if (state === 'SUCCESS' && !fulfillment?.exists) {
        tx.create(fulfillmentRef, { orderId: reference, status: stockReview ? 'stock_review' : 'queued', createdAt: now, lines: current.lines, delivery: current.delivery, idempotencyKey: `store-fulfill-${reference}` });
        this.jobs.enqueue(tx, `fulfill-${reference}`, 'fulfill', reference);
        if (stockReview) this.alert(tx, reference, 'stock_review');
      }
      return updated;
    });
    this.products.invalidateProductsCache();
    return result;
  }
  async reconcile() {
    if (this.running) return;
    this.running = true;
    try { await this.jobs.run(job => this.processJob(job)); } finally { this.running = false; }
  }
  async processJob(job: StoreJob): Promise<'done' | 'pending'> {
    if (job.kind === 'fulfill') return this.fulfill(job.reference);
    if (job.kind === 'webhook') {
      const eventRef = this.db.collection('storeWebhookEvents').doc(job.eventId!);
      const event = (await eventRef.get()).data()!;
      if (event.type !== 'charge.success') {
        // Refunds/disputes retain payment success and enter an auditable financial review.
        await this.db.runTransaction(async tx => {
          if ((await tx.get(eventRef)).data()?.state === 'completed') return;
          tx.update(eventRef, { state: 'completed', processedAt: Date.now() });
          this.alert(tx, job.reference || job.eventId!, 'refund_or_dispute_review');
          this.audit(tx, job.reference, 'FINANCIAL_EVENT_REVIEW', { eventId: job.eventId!, providerEventType: event.type });
        });
        return 'done';
      }
    }
    const exists = job.reference && (await this.db.collection('storeOrders').doc(job.reference).get()).exists;
    if (!exists) {
      if (job.eventId) await this.db.collection('storeWebhookEvents').doc(job.eventId).update({ state: 'ignored', processedAt: Date.now() });
      return 'done';
    }
    const order = await this.refresh(job.reference);
    const done = order.status === 'paid';
    // Failed and locally expired payments are still checked for late success.
    if (done && job.eventId) await this.db.collection('storeWebhookEvents').doc(job.eventId).update({ state: 'completed', processedAt: Date.now() });
    return done ? 'done' : 'pending';
  }
  private async fulfill(reference: string): Promise<'done' | 'pending'> {
    const ref = this.db.collection('storeFulfillments').doc(reference);
    const fulfillment = (await ref.get()).data();
    const order = (await this.db.collection('storeOrders').doc(reference).get()).data() as StoreOrder;
    if (!fulfillment || order?.status !== 'paid') throw new Error('Fulfillment requires verified payment.');
    if (fulfillment.status === 'completed') return 'done';
    if (fulfillment.status !== 'queued' || !process.env.STORE_FULFILLMENT_URL) return 'pending';
    // The configured receiver must durably deduplicate this key before acting.
    const response = await fetch(process.env.STORE_FULFILLMENT_URL, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.STORE_FULFILLMENT_TOKEN}`, 'Idempotency-Key': `store-fulfill-${reference}` },
      body: JSON.stringify({ orderId: reference, lines: order.lines, delivery: order.delivery }),
    });
    if (!response.ok) throw new Error('Fulfillment unavailable.');
    const receipt = await response.json() as { orderId?: string; accepted?: boolean };
    if (receipt.orderId !== reference || receipt.accepted !== true) throw new Error('Invalid fulfillment receipt.');
    await this.db.runTransaction(async tx => {
      if ((await tx.get(ref)).data()?.status === 'completed') return;
      tx.update(ref, { status: 'completed', completedAt: Date.now() });
      tx.update(this.db.collection('storeOrders').doc(reference), { fulfillmentStatus: 'completed' });
      this.audit(tx, reference, 'FULFILLMENT_ACCEPTED');
    });
    return 'done';
  }
  private async readProducts(tx: Transaction, items: CheckoutInput['items']) {
    const snapshots = await tx.getAll(...[...new Set(items.map(item => item.productId))].map(id => this.db.collection('products').doc(id)));
    return new Map(snapshots.filter(s => s.exists).map(s => [s.id, s.data() as ProductDocument]));
  }
  private stockTarget(product: ProductDocument | undefined, line: OrderLine) { return line.variantId ? product?.variants?.find(v => v.id === line.variantId) : product; }
  private changeStock(tx: Transaction, products: Map<string, ProductDocument>, lines: OrderLine[], direction: 1 | -1) {
    const changed = new Set<string>();
    for (const line of lines) {
      if (!line.stockTracking) continue;
      const target = this.stockTarget(products.get(line.productId), line);
      if (!target || !Number.isSafeInteger(target.inventoryQuantity) || target.inventoryQuantity + direction * line.quantity < 0) throw new ConflictException('Inventory changed.');
      target.inventoryQuantity += direction * line.quantity;
      changed.add(line.productId);
    }
    for (const id of changed) {
      const product = products.get(id)!;
      tx.update(this.db.collection('products').doc(id), { inventoryQuantity: product.inventoryQuantity, variants: product.variants ?? [], updatedAt: new Date().toISOString() });
    }
  }
  private session(order: StoreOrder) {
    if (!order.accessCode) throw new ServiceUnavailableException({ code: 'CHECKOUT_PENDING', message: 'Your checkout is saved and awaiting confirmation.' });
    return { accessCode: order.accessCode, reference: order.reference, currency: order.currency, subtotalMinor: order.subtotalMinor, deliveryMinor: order.deliveryMinor, amountMinor: order.amountMinor };
  }
  private verification(order: StoreOrder) {
    return { reference: order.reference, currency: order.currency, amountMinor: order.amountMinor, status: order.status === 'initializing' ? 'pending' : order.status, ...(order.status === 'paid' ? { orderId: order.reference } : {}) };
  }
}
