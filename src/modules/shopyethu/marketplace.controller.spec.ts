import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MarketplacePublicController } from './marketplace.controller';
import type { MarketplaceService } from './marketplace.service';

const controller = new MarketplacePublicController({} as MarketplaceService);

void test('store share links redirect to the encoded ShopYethu storefront route', () => {
  assert.deepEqual(controller.shareStore('seller/one'), {
    url: 'shopyethu://store/seller%2Fone',
    statusCode: 302,
  });
});

void test('store share redirects reject empty or oversized store IDs', () => {
  assert.throws(() => controller.shareStore(''));
  assert.throws(() => controller.shareStore('a'.repeat(151)));
});

void test('product share links redirect to the encoded ShopYethu product route', () => {
  assert.deepEqual(controller.shareProduct('product/one'), {
    url: 'shopyethu://product/product%2Fone',
    statusCode: 302,
  });
});

void test('product share redirects reject empty or oversized product IDs', () => {
  assert.throws(() => controller.shareProduct(''));
  assert.throws(() => controller.shareProduct('a'.repeat(151)));
});

void test('order QR redirects validate and preserve the current token in the app link', async () => {
  let validated: string[] | undefined;
  const orderController = new MarketplacePublicController({
    orders: {
      async assertCurrentQrToken(id: string, token: string) {
        validated = [id, token];
      },
    },
  } as unknown as MarketplaceService);

  assert.deepEqual(await orderController.shareOrder('order/one', 'current-token'), {
    url: 'shopyethu://order/order%2Fone?qrToken=current-token',
    statusCode: 302,
  });
  assert.deepEqual(validated, ['order/one', 'current-token']);
});
