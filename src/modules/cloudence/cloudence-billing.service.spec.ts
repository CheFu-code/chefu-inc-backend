import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { CloudenceBillingService } from './cloudence-billing.service';
import {
  MAX_STORAGE_BYTES,
  MAX_SUBSCRIBED_STORAGE_BYTES,
  SUBSCRIPTION_COLLECTION,
  SUBSCRIPTION_TOKEN_COLLECTION,
} from './cloudence.constants';
import { GooglePlayPublisherService } from './google-play-publisher.service';
import { GOOGLE_PLAY_PRODUCT_IDS } from './google-play-billing.constants';
import type { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

function fixture() {
  const records = new Map<string, Record<string, unknown>>();
  const snapshot = async (key: string) => {
    const data = records.get(key);
    return {
      exists: Boolean(data),
      data: () => (data ? structuredClone(data) : undefined),
    };
  };
  const doc = (key: string) => ({
    key,
    get: () => snapshot(key),
  });
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => doc(`${name}/${id}`),
    }),
    runTransaction: async <T>(
      operation: (transaction: {
        get: (ref: { key: string }) => ReturnType<typeof snapshot>;
        set: (
          ref: { key: string },
          value: Record<string, unknown>,
          options?: { merge?: boolean },
        ) => void;
      }) => Promise<T>,
    ) => {
      const writes: Array<{
        key: string;
        value: Record<string, unknown>;
        merge: boolean;
      }> = [];
      const result = await operation({
        get: (ref) => snapshot(ref.key),
        set: (ref, value, options) => {
          writes.push({
            key: ref.key,
            value,
            merge: options?.merge === true,
          });
        },
      });
      for (const write of writes) {
        records.set(
          write.key,
          write.merge
            ? { ...records.get(write.key), ...write.value }
            : write.value,
        );
      }
      return result;
    },
  };
  const purchases = new Map<
    string,
    {
      subscriptionState: string;
      acknowledgementState: string;
      linkedPurchaseToken?: string;
      lineItems: Array<{ productId: string; expiryTime: string }>;
    }
  >();
  const acknowledgements: string[] = [];
  const googlePlay = {
    isConfigured: () => true,
    getSubscription: async (token: string) => purchases.get(token),
    acknowledge: async (productId: string, token: string) => {
      acknowledgements.push(`${productId}:${token}`);
    },
  };
  const firebase = { db: () => db } as unknown as FirebaseAdminService;
  const service = new CloudenceBillingService(
    firebase,
    googlePlay as unknown as GooglePlayPublisherService,
  );
  return { service, records, purchases, acknowledgements };
}

function activeSubscription(
  productId: string,
  expiryTime = new Date(Date.now() + 86_400_000).toISOString(),
) {
  return {
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    externalAccountIdentifiers: {
      obfuscatedExternalAccountId: createHash('sha256')
        .update('user-1')
        .digest('hex'),
    },
    lineItems: [{ productId, expiryTime }],
  };
}

void test('verifies active Play purchase and persists only a token hash', async () => {
  const f = fixture();
  const productId = GOOGLE_PLAY_PRODUCT_IDS[0];
  const token = 'sensitive-google-purchase-token';
  f.purchases.set(token, activeSubscription(productId));

  const result = await f.service.verifyPurchase('user-1', productId, token);

  assert.equal(result.all, MAX_SUBSCRIBED_STORAGE_BYTES);
  assert.equal(result.plan, '50gb');
  assert.deepEqual(f.acknowledgements, [`${productId}:${token}`]);
  assert.ok(f.records.has(`${SUBSCRIPTION_COLLECTION}/user-1`));
  const persisted = JSON.stringify([...f.records.entries()]);
  assert.equal(persisted.includes(token), false);
  const tokenHash = createHash('sha256').update(token).digest('hex');
  assert.ok(f.records.has(`${SUBSCRIPTION_TOKEN_COLLECTION}/${tokenHash}`));
});

void test('equivalent Pro and storage products grant one non-stacking 50 GB quota', async () => {
  const f = fixture();
  const [proProduct, storageProduct] = GOOGLE_PLAY_PRODUCT_IDS;
  f.purchases.set('pro-token', activeSubscription(proProduct));
  f.purchases.set(
    'storage-token',
    activeSubscription(
      storageProduct,
      new Date(Date.now() + 172_800_000).toISOString(),
    ),
  );

  await f.service.verifyPurchase('user-1', proProduct, 'pro-token');
  const result = await f.service.verifyPurchase(
    'user-1',
    storageProduct,
    'storage-token',
  );

  assert.equal(result.all, MAX_SUBSCRIBED_STORAGE_BYTES);
  assert.equal(result.productId, storageProduct);
  assert.equal(result.plan, '50gb');
});

void test('expired Play subscriptions are rejected without granting more storage', async () => {
  const f = fixture();
  const productId = GOOGLE_PLAY_PRODUCT_IDS[0];
  f.purchases.set(
    'expired-token',
    activeSubscription(productId, new Date(Date.now() - 1000).toISOString()),
  );

  await assert.rejects(
    f.service.verifyPurchase('user-1', productId, 'expired-token'),
    /active subscription/,
  );
  assert.equal(
    (await f.service.getEntitlement('user-1')).all,
    MAX_STORAGE_BYTES,
  );
});

void test('a purchase bound to another user cannot be acknowledged or claimed', async () => {
  const f = fixture();
  const productId = GOOGLE_PLAY_PRODUCT_IDS[0];
  const token = 'bound-token';
  const tokenHash = createHash('sha256').update(token).digest('hex');
  f.purchases.set(token, activeSubscription(productId));
  f.records.set(`${SUBSCRIPTION_TOKEN_COLLECTION}/${tokenHash}`, {
    userId: 'other-user',
    productId,
  });

  await assert.rejects(
    f.service.verifyPurchase('user-1', productId, token),
    /already linked/,
  );
  assert.deepEqual(f.acknowledgements, []);
});

void test('purchases without the authenticated account identifier are rejected', async () => {
  const f = fixture();
  const productId = GOOGLE_PLAY_PRODUCT_IDS[0];
  const purchase = {
    ...activeSubscription(productId),
    externalAccountIdentifiers: undefined,
  };
  f.purchases.set('unbound-token', purchase);

  await assert.rejects(
    f.service.verifyPurchase('user-1', productId, 'unbound-token'),
    /different Cloudence account/,
  );
  assert.deepEqual(f.acknowledgements, []);
});

void test('Play revocation notifications remove paid storage entitlement', async () => {
  const f = fixture();
  const productId = GOOGLE_PLAY_PRODUCT_IDS[0];
  const token = 'revoked-token';
  f.purchases.set(token, activeSubscription(productId));
  await f.service.verifyPurchase('user-1', productId, token);

  assert.equal((await f.service.handleNotification(token, true)).processed, true);
  assert.equal(
    (await f.service.getEntitlement('user-1')).all,
    MAX_STORAGE_BYTES,
  );
});

void test('late notifications for replaced purchase tokens do not revoke the current plan', async () => {
  const f = fixture();
  const productId = GOOGLE_PLAY_PRODUCT_IDS[0];
  f.purchases.set('old-token', activeSubscription(productId));
  await f.service.verifyPurchase('user-1', productId, 'old-token');

  f.purchases.set('new-token', {
    ...activeSubscription(productId),
    linkedPurchaseToken: 'old-token',
  });
  await f.service.verifyPurchase('user-1', productId, 'new-token');

  const result = await f.service.handleNotification('old-token', true);
  assert.deepEqual(result, { processed: true, stale: true });
  assert.equal(
    (await f.service.getEntitlement('user-1')).all,
    MAX_SUBSCRIBED_STORAGE_BYTES,
  );
});
