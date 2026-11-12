import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { input, product, setup } from './checkout.testing';
import { priceOrder, validateCheckout } from './checkout.validation';
import { digest, paymentFromOrder, PaymentRecord, StoreOrder, transitionPayment, providerIdentity, backoff } from './payment.model';
import { PaystackError, PaystackService } from './paystack.service';
import { validateStoreEnv } from './store.config';
Logger.overrideLogger(false);

void test('strict validation rejects mass assignment, forged amounts/currency, discounts, duplicate lines and malformed delivery', () => {
  const valid = input();
  for (const body of [null, { ...valid, amountMinor: 1 }, { ...valid, status: 'paid' }, { ...valid, coupon: 'ADMIN' }, { ...valid, currency: 'USD' }, { ...valid, termsAccepted: false }, { ...valid, items: [] }, { ...valid, items: [valid.items[0], valid.items[0]] }, { ...valid, items: [{ productId: '../shirt', quantity: 1 }] }, { ...valid, items: [{ productId: 'shirt', quantity: 1.5 }] }, { ...valid, delivery: { ...valid.delivery, country: 'US' } }, { ...valid, delivery: { ...valid.delivery, email: 'bad' } }]) assert.throws(() => validateCheckout(body));
  assert.equal(validateCheckout(valid).delivery.postalCode, '0123');
});
void test('server catalog validates stock, variant relationships, integer prices and delivery threshold', () => {
  const lines = validateCheckout(input()).items;
  assert.equal(priceOrder(lines, new Map([['shirt', product()]])).amountMinor, 56_000);
  assert.equal(priceOrder([{ productId: 'shirt', quantity: 4 }], new Map([['shirt', product()]])).deliveryMinor, 0);
  for (const overrides of [{ inventoryQuantity: 1 }, { status: 'DRAFT' as const }, { priceMinor: -1 }]) assert.throws(() => priceOrder(lines, new Map([['shirt', product(overrides)]])));
  const variants = [{ id: 'large', name: 'Large', sku: 'L', priceMinor: 30_000, inventoryQuantity: 2, options: {} }];
  assert.throws(() => priceOrder(lines, new Map([['shirt', product({ variants })]])));
  assert.equal(priceOrder([{ productId: 'shirt', variantId: 'large', quantity: 2 }], new Map([['shirt', product({ variants })]])).amountMinor, 66_000);
});
void test('five taps, different keys and multiple instances produce one payable checkout and one stock reservation', async () => {
  const s = setup();
  await Promise.allSettled(Array.from({ length: 5 }, (_, i) => (i % 2 ? s.service : s.newService()).initialize('owner', `key-${i}`, input())));
  assert.equal(s.calls.initialize, 1);
  assert.equal(s.count('storeOrders'), 1);
  assert.equal(s.records.get('products/shirt')!.inventoryQuantity, 98);
  const recovery = await s.service.recover('owner');
  assert.ok(recovery.checkout?.accessCode);
  await assert.rejects(s.service.initialize('owner', 'key-0', { ...input(), items: [{ productId: 'shirt', quantity: 1 }] }), /saved checkout/);
});
void test('competing accounts cannot oversell and inventory changes roll back with rejected orders', async () => {
  const s = setup();
  s.records.set('products/shirt', product({ inventoryQuantity: 2 }));
  const results = await Promise.allSettled(['one', 'two'].map(uid => s.service.initialize(uid, 'key', input())));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(s.records.get('products/shirt')!.inventoryQuantity, 0);
  assert.equal(s.count('storeOrders'), 1);
  assert.equal(s.count('storePayments'), 1);
});
void test('lost initialization response is never retried as a provider POST, even after a restart or lease timeout', async () => {
  const s = setup();
  const original = s.gateway.initialize;
  s.gateway.initialize = async order => { await original(order); throw new Error('connection lost'); };
  await assert.rejects(s.service.initialize('owner', 'key', input()), /saved/);
  const saved = await s.newService().recover('owner');
  assert.ok(saved.checkout);
  assert.equal(saved.checkout.accessCode, undefined);
  await assert.rejects(s.newService().initialize('owner', 'another-key', input()));
  assert.equal(s.calls.initialize, 1);
  assert.equal(s.count('storeOrders'), 1);
  assert.equal(s.records.get('products/shirt')!.inventoryQuantity, 98);
});
void test('successful payment recovers after phone shutdown, browser crash, lost redirect and another-device login', async () => {
  const s = setup();
  const session = await s.service.initialize('account', 'key', input());
  s.payments.get(session.reference)!.status = 'success';
  s.due();
  await s.newService().reconcile();
  const recovered = await s.newService().recover('account');
  assert.equal(recovered.checkout?.status, 'paid');
  assert.equal(recovered.checkout?.orderId, session.reference);
  assert.equal(s.count('storeFulfillments'), 1);
  assert.equal((await s.service.history('account')).orders.length, 1);
  assert.deepEqual(await s.service.recover('attacker'), { checkout: null });
});
void test('ownership checks reject another account and guessed references without spending gateway quota', async () => {
  const s = setup();
  const session = await s.service.initialize('account', 'key', input());
  await assert.rejects(s.service.verify('attacker', session.reference), /not found/);
  await assert.rejects(s.service.verify('account', 'store-forged'), /not found/);
  await assert.rejects(s.service.acknowledge('attacker', session.reference), /not found/);
  assert.equal(s.calls.verify, 0);
  assert.equal(s.records.get(`storeOrders/${session.reference}`)!.status, 'pending');
});
void test('legacy claims require both authentication and original cookie, never a matching delivery email alone', async () => {
  const s = setup();
  const session = await s.service.initialize('old', 'key', input());
  const record = s.records.get(`storeOrders/${session.reference}`)!;
  delete record.accountUid;
  record.ownerHash = digest('original-cookie');
  await assert.rejects(s.service.claimLegacy('attacker', session.reference, 'wrong-cookie'), /not found/);
  const claimed = await s.service.claimLegacy('new-account', session.reference, 'original-cookie');
  assert.equal(claimed.checkout?.reference, session.reference);
  assert.equal(record.ownerHash, digest('original-cookie'));
  await assert.rejects(s.service.verify(undefined, session.reference, 'original-cookie'), /not found/);
});
void test('wrong amount, currency, order, attempt, customer, provider mode or identity enters review without fulfillment', async () => {
  for (const change of [{ amount: 1 }, { currency: 'USD' }, { reference: 'other' }, { metadata: { orderId: 'other' } }, { metadata: { orderId: '', paymentAttemptId: 'wrong' } }, { customer: { email: 'attacker@example.com' } }, { domain: 'live' as const }, { id: Number.MAX_SAFE_INTEGER + 1 }]) {
    const s = setup();
    const session = await s.service.initialize('owner', 'key', input());
    const provider = { ...s.payments.get(session.reference)!, status: 'success', ...change };
    const result = await s.service.applyPayment(session.reference, provider);
    assert.notEqual(result.status, 'paid');
    assert.equal(s.records.get(`storePayments/${session.reference}`)!.state, 'REQUIRES_REVIEW');
    assert.equal(s.count('storeFulfillments'), 0);
    assert.equal(s.count('storeAlerts'), 1);
  }
});
void test('provider transaction uniqueness prevents one provider ID from funding unrelated orders', async () => {
  const s = setup();
  const first = await s.service.initialize('first', 'key', input());
  const second = await s.service.initialize('second', 'key', input());
  const p1 = { ...s.payments.get(first.reference)!, status: 'success' };
  const p2 = { ...s.payments.get(second.reference)!, status: 'success', id: p1.id };
  await Promise.all([s.service.applyPayment(first.reference, p1), s.newService().applyPayment(second.reference, p2)]);
  assert.equal(s.count('storeProviderTransactions'), 1);
  assert.equal(s.count('storeFulfillments'), 1);
  assert.equal(s.records.get(`storePayments/${second.reference}`)!.state, 'REQUIRES_REVIEW');
});
void test('timeouts and provider outages preserve pending outcome and stock, then verification recovers', async () => {
  for (const failure of ['TIMEOUT', 'UNAVAILABLE', 'NOT_FOUND', 'RATE_LIMITED'] as const) {
    const s = setup();
    const session = await s.service.initialize('owner', 'key', input());
    const verify = s.gateway.verify;
    s.gateway.verify = async () => { throw new PaystackError(failure); };
    assert.equal((await s.service.verify('owner', session.reference)).status, 'pending');
    assert.equal(s.records.get(`storePayments/${session.reference}`)!.lastOutcome, failure);
    assert.equal(s.records.get('products/shirt')!.inventoryQuantity, 98);
    s.gateway.verify = verify;
    s.payments.get(session.reference)!.status = 'success';
    s.due();
    assert.equal((await s.service.verify('owner', session.reference)).status, 'paid');
    assert.equal(s.count('storeFulfillments'), 1);
  }
});
void test('verification floods coalesce through a durable per-payment lease across instances', async () => {
  const s = setup();
  const session = await s.service.initialize('owner', 'key', input());
  await Promise.all(Array.from({ length: 20 }, () => s.newService().verify('owner', session.reference)));
  assert.equal(s.calls.verify, 1);
  assert.equal(s.count('storeOrders'), 1);
});
void test('local expiry does not release stock; late success settles and stale failure cannot downgrade it', async () => {
  const s = setup();
  const session = await s.service.initialize('owner', 'key', input());
  s.records.get(`storePayments/${session.reference}`)!.expiresAt = 0;
  s.payments.get(session.reference)!.status = 'abandoned';
  await s.service.verify('owner', session.reference);
  assert.equal(s.records.get(`storePayments/${session.reference}`)!.state, 'EXPIRED');
  assert.equal(s.records.get('products/shirt')!.inventoryQuantity, 98);
  const paid = { ...s.payments.get(session.reference)!, status: 'success' };
  await s.service.applyPayment(session.reference, paid);
  await s.service.applyPayment(session.reference, { ...paid, status: 'failed' });
  assert.equal(s.records.get(`storeOrders/${session.reference}`)!.status, 'paid');
  assert.equal(s.records.get(`storePayments/${session.reference}`)!.state, 'SUCCESS');
  assert.equal(s.count('storeFulfillments'), 1);
});
void test('definitive failure releases once and late success with insufficient stock requires review', async () => {
  const s = setup();
  const session = await s.service.initialize('owner', 'key', input());
  const failed = { ...s.payments.get(session.reference)!, status: 'failed' };
  await s.service.applyPayment(session.reference, failed);
  await s.service.applyPayment(session.reference, failed);
  assert.equal(s.records.get('products/shirt')!.inventoryQuantity, 100);
  s.records.get('products/shirt')!.inventoryQuantity = 0;
  await s.service.applyPayment(session.reference, { ...failed, status: 'success' });
  assert.equal(s.records.get(`storeOrders/${session.reference}`)!.status, 'paid');
  assert.equal(s.records.get(`storeFulfillments/${session.reference}`)!.status, 'stock_review');
  assert.equal(s.records.get('products/shirt')!.inventoryQuantity, 0);
});
void test('durable webhook inbox deduplicates, survives process loss and confirms concurrently with reconciliation', async () => {
  const s = setup();
  const session = await s.service.initialize('owner', 'key', input());
  s.payments.get(session.reference)!.status = 'success';
  const event = { event: 'charge.success', data: { reference: session.reference } };
  await Promise.all([s.service.webhook(event, 'event1'), s.newService().webhook(event, 'event1')]);
  assert.equal(s.count('storeWebhookEvents'), 1);
  assert.equal(s.count('storeFulfillments'), 0, 'acknowledgment only persisted the event');
  s.due();
  await Promise.all([s.newService().reconcile(), s.newService().reconcile(), s.service.verify('owner', session.reference)]);
  assert.equal(s.count('storeFulfillments'), 1);
  assert.equal(s.records.get(`storeOrders/${session.reference}`)!.status, 'paid');
  assert.equal(s.records.get('storeWebhookEvents/event1')!.state, 'completed');
});
void test('crashed worker leases are reclaimed and unresolved jobs escalate instead of retrying forever', async () => {
  const s = setup();
  const session = await s.service.initialize('owner', 'key', input());
  const job = s.records.get(`storeJobs/verify-${session.reference}`)!;
  job.state = 'running'; job.leaseToken = 'dead-worker'; job.availableAt = 0; job.attempts = 39;
  await s.newService().reconcile();
  assert.equal(s.records.get(`storeJobs/verify-${session.reference}`)!.state, 'dead');
  assert.equal(s.count('storeAlerts'), 1);
  await s.jobs.retry(`verify-${session.reference}`, 'admin');
  assert.equal(s.records.get(`storeJobs/verify-${session.reference}`)!.state, 'queued');
  assert.ok([...s.records.values()].some(value => value.action === 'JOB_RETRY'));
});
void test('a crash after external fulfillment retries the stable idempotency key without duplicating delivery', async t => {
  const s = setup();
  const session = await s.service.initialize('owner', 'key', input());
  await s.service.applyPayment(session.reference, { ...s.payments.get(session.reference)!, status: 'success' });
  process.env.STORE_FULFILLMENT_URL = 'https://fulfillment.example/orders';
  process.env.STORE_FULFILLMENT_TOKEN = 'test-token';
  t.after(() => { delete process.env.STORE_FULFILLMENT_URL; delete process.env.STORE_FULFILLMENT_TOKEN; });
  const delivered = new Set<string>();
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    delivered.add((options.headers as Record<string, string>)['Idempotency-Key']);
    attempts++;
    if (attempts === 1) throw new Error('response lost after receiver committed delivery');
    return new Response(JSON.stringify({ accepted: true, orderId: session.reference }));
  });
  s.due(); await s.service.reconcile();
  assert.equal(s.records.get(`storeFulfillments/${session.reference}`)!.status, 'queued');
  s.due(); await s.newService().reconcile();
  assert.equal(delivered.size, 1);
  assert.equal(attempts, 2);
  assert.equal(s.records.get(`storeFulfillments/${session.reference}`)!.status, 'completed');
  assert.equal(s.records.get(`storeOrders/${session.reference}`)!.fulfillmentStatus, 'completed');
});
void test('refund and dispute notifications preserve payment success and create auditable review without executing refunds', async () => {
  const s = setup();
  const session = await s.service.initialize('owner', 'key', input());
  await s.service.applyPayment(session.reference, { ...s.payments.get(session.reference)!, status: 'success' });
  for (const [i, type] of ['refund.processed', 'charge.dispute.create'].entries()) {
    await s.service.webhook({ event: type, data: { transaction: { reference: session.reference } } }, `event-${i}`);
  }
  await s.service.reconcile();
  assert.equal(s.records.get(`storeOrders/${session.reference}`)!.status, 'paid');
  assert.equal([...s.records.values()].filter(record => record.action === 'FINANCIAL_EVENT_REVIEW').length, 2);
  assert.ok([...s.records.values()].some(record => record.type === 'refund_or_dispute_review'));
});
void test('account acknowledgment allows a subsequent purchase without losing the original idempotent result', async () => {
  const s = setup();
  const session = await s.service.initialize('owner', 'key', input());
  await assert.rejects(s.service.acknowledge('owner', session.reference), /unresolved/);
  await s.service.applyPayment(session.reference, { ...s.payments.get(session.reference)!, status: 'success' });
  await s.service.acknowledge('owner', session.reference);
  assert.deepEqual(await s.service.recover('owner'), { checkout: null });
  assert.deepEqual(await s.service.initialize('owner', 'key', input()), session);
  const next = await s.service.initialize('owner', 'new-key', input());
  assert.notEqual(next.reference, session.reference);
  assert.equal(s.count('storeOrders'), 2);
});
void test('daily account quota persists across instance changes and rejected creation has no business effects', async () => {
  const s = setup();
  s.records.set(`storeCheckoutAccounts/${digest('owner')}`, { quotaDate: new Date().toISOString().slice(0, 10), creations: 10 });
  await assert.rejects(s.newService().initialize('owner', 'key', input()), /limit/);
  assert.equal(s.calls.initialize, 0);
  assert.equal(s.count('storeOrders'), 0);
  assert.equal(s.records.get('products/shirt')!.inventoryQuantity, 100);
});
void test('state machine rejects invalid transitions and treats SUCCESS as absorbing', () => {
  const base = { state: 'FAILED', version: 1 } as PaymentRecord;
  assert.throws(() => transitionPayment(base, 'INITIALIZED'), /Invalid/);
  assert.equal(transitionPayment(base, 'SUCCESS').state, 'SUCCESS');
  assert.equal(transitionPayment({ ...base, state: 'SUCCESS' }, 'FAILED').state, 'SUCCESS');
  assert.equal(providerIdentity('18446744073709551615'), '18446744073709551615');
  assert.equal(providerIdentity(9007199254740992), undefined);
  assert.ok(backoff(40, () => 0.5) <= 6 * 60 * 60_000);
});
void test('startup config isolates test/live keys, requires HTTPS and distributed production limits', () => {
  assert.equal(validateStoreEnv({}).missing.length, 0);
  assert.ok(validateStoreEnv({ PAYSTACK_SECRET_KEY: 'sk_test_test', PAYSTACK_MODE: 'live' }).missing.some(v => v.name === 'PAYSTACK_MODE'));
  assert.ok(validateStoreEnv({ NODE_ENV: 'production', PAYSTACK_SECRET_KEY: 'sk_live_test', PAYSTACK_MODE: 'live', BACKEND_PUBLIC_URL: 'http://example.com' }).missing.length >= 2);
  assert.ok(validateStoreEnv({ STORE_FULFILLMENT_URL: 'https://user:password@example.com' }).missing.length >= 2);
});
void test('legacy model conversion preserves paid state and marks initialization already dispatched', () => {
  const payment = paymentFromOrder({ reference: 'legacy', status: 'paid', createdAt: 1, updatedAt: 2 } as StoreOrder);
  assert.equal(payment.state, 'SUCCESS');
  assert.equal(payment.initializationDispatched, true);
});
void test('webhook HMAC uses exact bytes, rejects forgery and rejects legacy downgrade with current signing secret', t => {
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_test';
  t.after(() => { delete process.env.PAYSTACK_SECRET_KEY; delete process.env.PAYSTACK_WEBHOOK_SECRET; });
  const service = new PaystackService();
  const raw = Buffer.from('{ "event": "charge.success" }');
  const signature = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex');
  service.authenticateWebhook(raw, undefined, signature);
  assert.throws(() => service.authenticateWebhook(Buffer.from('{}'), undefined, signature));
  assert.throws(() => service.authenticateWebhook(raw));
  process.env.PAYSTACK_WEBHOOK_SECRET = 'whsec_test';
  assert.throws(() => service.authenticateWebhook(raw, undefined, signature));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signed = createHmac('sha512', 'whsec_test').update(`${timestamp}.`).update(raw).digest('hex');
  service.authenticateWebhook(raw, `t=${timestamp},v1=whk_test:${signed}`);
  assert.throws(() => service.authenticateWebhook(raw, `t=1,v1=whk_test:${signed}`));
});
void test('gateway GET retries are bounded, POST never retries, 64-bit IDs remain exact, and 429 cooldown is preserved', async t => {
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_test';
  t.after(() => { delete process.env.PAYSTACK_SECRET_KEY; });
  let calls = 0;
  const fetch = t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('{}', { status: 503 }); });
  const service = new PaystackService();
  await assert.rejects(service.verify('ref'));
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(service.initialize({ reference: 'ref', amountMinor: 100, delivery: { email: 'a@example.com' } }));
  assert.equal(calls, 1);
  fetch.mock.mockImplementation(async () => new Response('{"status":true,"data":{"id":18446744073709551615}}'));
  assert.equal((await service.verify('ref')).id, '18446744073709551615');
  fetch.mock.mockImplementation(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }));
  await assert.rejects(service.verify('ref'), error => error instanceof PaystackError && error.outcome === 'RATE_LIMITED' && error.retryAfterMs === 120_000);
});
