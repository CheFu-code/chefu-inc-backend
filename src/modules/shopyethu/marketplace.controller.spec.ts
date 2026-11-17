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
