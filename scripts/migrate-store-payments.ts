import 'reflect-metadata';
import { FieldPath } from 'firebase-admin/firestore';
import { FirebaseAdminService } from '../src/modules/firebase-admin/firebase-admin.service';
import { paymentFromOrder, StoreOrder } from '../src/modules/store/payment.model';
import { StoreJobsService } from '../src/modules/store/store-jobs.service';

// Additive, resumable, dry-run by default. No stock, payment status, or ownership changes.
export async function migrateStorePayments(firebase: FirebaseAdminService, apply = false) {
  const db = firebase.db();
  const jobs = new StoreJobsService(firebase);
  let cursor: string | undefined;
  let scanned = 0;
  let migrated = 0;
  while (true) {
    let query = db.collection('storeOrders').orderBy(FieldPath.documentId()).limit(100);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    for (const snapshot of page.docs) {
      scanned++;
      const order = snapshot.data() as StoreOrder;
      if (!apply) { if (!(await db.collection('storePayments').doc(snapshot.id).get()).exists) migrated++; continue; }
      await db.runTransaction(async tx => {
        // Reread inside the transaction: a webhook can settle an order during migration.
        const latest = (await tx.get(snapshot.ref)).data() as StoreOrder;
        const paymentRef = db.collection('storePayments').doc(snapshot.id);
        const payment = await tx.get(paymentRef);
        const jobId = `${latest.status === 'paid' ? 'fulfill' : 'verify'}-${snapshot.id}`;
        const job = await tx.get(db.collection('storeJobs').doc(jobId));
        const fulfillmentRef = db.collection('storeFulfillments').doc(snapshot.id);
        const fulfillment = await tx.get(fulfillmentRef);
        if (!payment.exists) { tx.create(paymentRef, paymentFromOrder(latest)); }
        if (!job.exists) {
          if (latest.status === 'paid') {
            // Existing staff may already have shipped legacy orders. Require review before
            // activating a new delivery integration; never replay historical side effects.
            if (!fulfillment.exists) tx.create(fulfillmentRef, { orderId: snapshot.id, status: 'migration_review', createdAt: Date.now() });
            else if (fulfillment.data()?.status !== 'completed') tx.update(fulfillmentRef, { status: 'migration_review' });
            jobs.enqueue(tx, jobId, 'fulfill', snapshot.id);
          } else jobs.enqueue(tx, jobId, 'verify', snapshot.id);
        }
        tx.set(db.collection('storeMigrationRecords').doc(snapshot.id), { version: 2, migratedAt: Date.now() });
      });
      migrated++;
    }
    cursor = page.docs.at(-1)!.id;
  }
  return { apply, scanned, migrated };
}

if (process.argv[1]?.replace(/\\/g, '/').match(/\/migrate-store-payments\.(ts|js)$/)) {
  void migrateStorePayments(new FirebaseAdminService(), process.argv.includes('--apply'))
    .then(result => console.log(JSON.stringify(result)))
    .catch(() => { console.error('Store migration failed; rerun after resolving database access. No secrets or customer data logged.'); process.exitCode = 1; });
}
