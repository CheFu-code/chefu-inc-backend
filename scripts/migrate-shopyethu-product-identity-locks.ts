import 'reflect-metadata';
import { FieldPath } from 'firebase-admin/firestore';
import { FirebaseAdminService } from '../src/modules/firebase-admin/firebase-admin.service';

type ReferencedProduct = { productId?: unknown };

export async function migrateShopYethuProductIdentityLocks(firebase: FirebaseAdminService, apply = false) {
  const db = firebase.db();
  const productIds = new Set<string>();
  const result = {
    apply,
    scannedOrders: 0,
    scannedReviews: 0,
    productsReferenced: 0,
    productsNeedingLock: 0,
    missingProducts: 0,
  };

  for (const [collectionName, countKey] of [
    ['shopyethu_orders', 'scannedOrders'],
    ['shopyethu_reviews', 'scannedReviews'],
  ] as const) {
    let cursor: string | undefined;
    while (true) {
      let query = db.collection(collectionName).orderBy(FieldPath.documentId()).limit(100);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      for (const document of page.docs) {
        result[countKey]++;
        const data = document.data();
        const references: ReferencedProduct[] = collectionName === 'shopyethu_orders'
          ? Array.isArray(data.items) ? data.items : []
          : [data];
        for (const reference of references) {
          if (typeof reference.productId !== 'string' || !reference.productId ||
            /[/\\]/.test(reference.productId)) {
            if (reference.productId !== undefined) throw new Error('Invalid product reference in migration input.');
            continue;
          }
          productIds.add(reference.productId);
        }
      }
      cursor = page.docs.at(-1)?.id;
    }
  }

  result.productsReferenced = productIds.size;
  for (const id of productIds) {
    const ref = db.collection('shopyethu_products').doc(id);
    if (!apply) {
      const product = await ref.get();
      if (!product.exists) {
        result.missingProducts++;
      } else if (product.data()?.identityLocked !== true) {
        result.productsNeedingLock++;
      }
      continue;
    }
    const outcome = await db.runTransaction(async transaction => {
      const product = await transaction.get(ref);
      if (!product.exists) return 'missing';
      if (product.data()?.identityLocked === true) return 'already-locked';
      transaction.set(ref, { identityLocked: true }, { merge: true });
      return 'locked';
    });
    if (outcome === 'locked') result.productsNeedingLock++;
    else if (outcome === 'missing') result.missingProducts++;
  }
  return result;
}

if (process.argv[1]?.replace(/\\/g, '/').match(/\/migrate-shopyethu-product-identity-locks\.(ts|js)$/)) {
  void migrateShopYethuProductIdentityLocks(new FirebaseAdminService(), process.argv.includes('--apply'))
    .then(result => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error('ShopYethu product identity-lock migration failed; check database access and retry. No customer data was logged.');
      process.exitCode = 1;
    });
}
