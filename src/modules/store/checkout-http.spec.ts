import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { ExecutionContext, Logger, Module, UnauthorizedException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import cookieParser from 'cookie-parser';
import { configureCors, createCookieCsrfMiddleware } from '../../common/http-security';
import { RuntimeLimitService } from '../../common/runtime-limit.service';
import { AuthGuard } from '../auth/auth.guard';
import { OAuthService } from '../auth/oauth.service';
import { HoneytokenService } from '../auth/honeytoken.service';
import { SessionSignerService } from '../auth/session-signer.service';
import { AdminGuard } from '../auth/admin.guard';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { CheckoutController } from './checkout.controller';
import { CheckoutAccessGuard, CheckoutRequest } from './checkout-access.guard';
import { StoreAdminController } from './store-admin.controller';
import { CheckoutService } from './checkout.service';
import { StoreJobsService } from './store-jobs.service';
import { PaystackService } from './paystack.service';
import { input, setup } from './checkout.testing';

void test('HTTP checkout authentication, DTOs, recovery, quotas, durable webhook ACK and privileged routes', async t => {
  Logger.overrideLogger(false);
  const s = setup();
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_test';
  const auth = { canActivate: (context: ExecutionContext) => {
    const req = context.switchToHttp().getRequest<CheckoutRequest>();
    const uid = req.get('authorization')?.replace(/^Bearer /, '');
    if (!uid) throw new UnauthorizedException();
    req.user = { uid, email: `${uid}@example.com`, roles: uid === 'admin' ? ['admin'] : [] };
    return true;
  } };
  t.mock.method(AuthGuard.prototype, 'canActivate', async (context: ExecutionContext) => auth.canActivate(context));
  @Module({ controllers: [CheckoutController, StoreAdminController], providers: [CheckoutAccessGuard, AdminGuard,
    { provide: AuthGuard, useValue: auth }, { provide: FirebaseAdminService, useValue: s.firebase },
    { provide: OAuthService, useValue: {} }, { provide: HoneytokenService, useValue: {} }, { provide: SessionSignerService, useValue: {} },
    { provide: CheckoutService, useValue: s.service }, { provide: StoreJobsService, useValue: s.jobs },
    { provide: PaystackService, useValue: new PaystackService() },
    { provide: RuntimeLimitService, useValue: new RuntimeLimitService(s.firebase) },
  ] }) class TestApp {}
  const app = await NestFactory.create<NestExpressApplication>(TestApp, { bodyParser: false, rawBody: true, logger: false, abortOnError: false });
  app.use('/store/checkout/webhook', express.json({ limit: '64kb', verify: (req, _res, bytes) => { (req as express.Request & { rawBody: Buffer }).rawBody = bytes; } }));
  app.use('/store/checkout', express.json({ limit: '32kb' }));
  app.useBodyParser('json'); app.use(cookieParser());
  configureCors(app, ['https://chefu.co.za']);
  app.use(createCookieCsrfMiddleware(['https://chefu.co.za']));
  await app.listen(0, '127.0.0.1');
  t.after(async () => { await app.close(); delete process.env.PAYSTACK_SECRET_KEY; });
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Origin: 'https://chefu.co.za', 'Content-Type': 'application/json', 'Idempotency-Key': 'test-key', Authorization: 'Bearer owner' };
  const post = (path: string, body: unknown, extra = headers) => fetch(`${base}${path}`, { method: 'POST', headers: extra, body: JSON.stringify(body) });
  const preflight = await fetch(`${base}/store/checkout/initialize`, { method: 'OPTIONS', headers: { Origin: headers.Origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,idempotency-key' } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers')!, /Idempotency-Key/i);
  const noLogin = { ...headers, Authorization: '' };
  assert.equal((await post('/store/checkout/initialize', input(), noLogin)).status, 401);
  assert.equal((await post('/STORE/CHECKOUT/INITIALIZE/', input(), { ...headers, Origin: '' })).status, 403);
  assert.equal((await post('/store/checkout/initialize', { ...input(), amountMinor: 1 })).status, 400);
  assert.equal((await post('/store/checkout/initialize', { ...input(), items: [{ productId: 'shirt', quantity: 2, priceMinor: 1 }] })).status, 400);
  assert.equal(s.count('storeOrders'), 0);
  const malformed = await fetch(`${base}/store/checkout/initialize`, { method: 'POST', headers, body: '{' });
  assert.equal(malformed.status, 400);
  const response = await post('/store/checkout/initialize', input());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const session = await response.json() as { reference: string };
  assert.equal(s.count('storePayments'), 1);
  const other = await post('/store/checkout/verify', { reference: session.reference }, { ...headers, Authorization: 'Bearer attacker' });
  assert.equal(other.status, 404);
  assert.equal(s.calls.verify, 0);
  assert.equal((await post('/store/admin/retry-job', { reference: `verify-${session.reference}` })).status, 403);
  assert.equal((await post('/store/checkout/refund', { reference: session.reference, amount: 1 })).status, 404);
  assert.equal(s.count('storeFulfillments'), 0);
  const forged = await post('/store/checkout/webhook', { event: 'charge.success', data: { reference: session.reference } });
  assert.equal(forged.status, 401);
  assert.equal(s.count('storeWebhookEvents'), 0);
  const oversized = await post('/store/checkout/webhook', { padding: 'x'.repeat(70_000) });
  assert.equal(oversized.status, 413);
  const raw = `{ "event": "charge.success", "data": {"reference":"${session.reference}"} }`;
  const signature = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!).update(raw).digest('hex');
  s.payments.get(session.reference)!.status = 'success';
  const webhook = await fetch(`${base}/store/checkout/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature }, body: raw });
  assert.equal(webhook.status, 200);
  assert.equal(s.count('storeWebhookEvents'), 1);
  assert.equal(s.count('storeFulfillments'), 0);
  await s.newService().reconcile();
  assert.equal(s.count('storeFulfillments'), 1);
  const recovered = await fetch(`${base}/store/checkout/recover`, { headers });
  assert.equal((await recovered.json() as { checkout: { status: string } }).checkout.status, 'paid');
  for (let i = 0; i < 20; i++) await post('/store/checkout/initialize', input());
  assert.equal((await post('/store/checkout/initialize', input())).status, 429);
  assert.equal(s.count('storeOrders'), 1);
  for (let i = 0; i < 60; i++) await post('/store/checkout/verify', { reference: session.reference });
  assert.equal((await post('/store/checkout/verify', { reference: session.reference })).status, 429);
  assert.equal(s.count('storeFulfillments'), 1);
});
