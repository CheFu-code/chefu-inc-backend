import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionContext, Logger, Module, UnauthorizedException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import puppeteer from 'puppeteer';
import { CheckoutController } from '../src/modules/store/checkout.controller';
import { CheckoutService } from '../src/modules/store/checkout.service';
import { CheckoutAccessGuard, CheckoutRequest } from '../src/modules/store/checkout-access.guard';
import { PaystackService } from '../src/modules/store/paystack.service';
import { AuthGuard } from '../src/modules/auth/auth.guard';
import { RuntimeLimitService } from '../src/common/runtime-limit.service';
import { configureCors, createCookieCsrfMiddleware } from '../src/common/http-security';
import { input, setup } from '../src/modules/store/checkout.testing';

// Run company-app on 3015 with NEXT_PUBLIC_CHECKOUT_ENABLED=true and
// NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4015. All database/provider data is isolated.
void test('real browser recovers across offline use and device loss, and popup success cannot mark an unpaid order paid', async t => {
  Logger.overrideLogger(false);
  const s = setup();
  const session = await s.service.initialize('owner', 'browser-test', input());
  @Module({ controllers: [CheckoutController], providers: [CheckoutAccessGuard,
    { provide: CheckoutService, useValue: s.service }, { provide: PaystackService, useValue: new PaystackService() },
    { provide: RuntimeLimitService, useValue: new RuntimeLimitService(s.firebase) },
    { provide: AuthGuard, useValue: { canActivate: (context: ExecutionContext) => {
      const request = context.switchToHttp().getRequest<CheckoutRequest>();
      if (request.cookies?.__session !== 'browser-account') throw new UnauthorizedException();
      request.user = { uid: 'owner', email: 'owner@example.com', roles: [] }; return true;
    } } },
  ] }) class BrowserApi {}
  const app = await NestFactory.create<NestExpressApplication>(BrowserApi, { logger: false, abortOnError: false });
  app.use(cookieParser()); configureCors(app, ['http://127.0.0.1:3015']);
  app.use(createCookieCsrfMiddleware(['http://127.0.0.1:3015']));
  await app.listen(4015, '127.0.0.1');
  t.after(async () => app.close());
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.STORE_TEST_BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  t.after(async () => browser.close());
  const context = await browser.createBrowserContext();
  await context.setCookie({ name: '__session', value: 'browser-account', domain: '127.0.0.1', path: '/', httpOnly: true });
  const page = await context.newPage();
  await page.setRequestInterception(true);
  page.on('request', request => { void (request.url().startsWith('http://127.0.0.1:') || request.url().startsWith('data:') ? request.continue() : request.abort()); });
  await page.evaluateOnNewDocument(() => {
    Object.assign(window, { PaystackPop: class { resumeTransaction(_code: string, callbacks: { onSuccess: (data: { reference: string }) => void }) { callbacks.onSuccess({ reference: 'untrusted-popup-reference' }); } } });
  });
  await page.goto('http://127.0.0.1:3015/store/cart', { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(() => document.body.innerText.includes('Check payment status'), { timeout: 60_000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('chefu-pending-payment')), null);
  await page.evaluate(() => { const button = [...document.querySelectorAll('button')].find(button => button.textContent?.includes('with Paystack')); if (!button) throw new Error('Missing resume button'); button.click(); });
  await page.waitForFunction(() => document.body.innerText.includes('has not been confirmed yet'));
  assert.equal(s.records.get(`storeOrders/${session.reference}`)!.status, 'pending');
  assert.equal(s.count('storeFulfillments'), 0);
  await page.setOfflineMode(true);
  await page.evaluate(() => { [...document.querySelectorAll('button')].find(button => button.textContent?.includes('Check payment status'))!.click(); });
  await page.waitForFunction(() => !document.body.innerText.includes('Checking your payment'));
  assert.equal(s.count('storeOrders'), 1);
  await context.close();
  // The customer never returns; an independent worker discovers the real provider result.
  s.payments.get(session.reference)!.status = 'success'; s.due(); await s.newService().reconcile();
  const newDevice = await browser.createBrowserContext();
  await newDevice.setCookie({ name: '__session', value: 'browser-account', domain: '127.0.0.1', path: '/', httpOnly: true });
  const restored = await newDevice.newPage();
  await restored.goto('http://127.0.0.1:3015/store/cart', { waitUntil: 'domcontentloaded' });
  await restored.waitForFunction(() => document.body.innerText.includes('Payment confirmed'));
  assert.equal(await restored.evaluate(() => sessionStorage.getItem('chefu-pending-payment')), null);
  assert.equal(s.count('storeOrders'), 1);
  assert.equal(s.count('storeFulfillments'), 1);
  assert.equal(s.records.get(`storeOrders/${session.reference}`)!.status, 'paid');
});
