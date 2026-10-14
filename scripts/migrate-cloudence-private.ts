import { randomUUID } from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import { FieldValue, FieldPath } from 'firebase-admin/firestore';
import { FirebaseAdminService } from '../src/modules/firebase-admin/firebase-admin.service';
import { assertCloudinaryConfigured } from '../src/common/env';
import { COLLECTION } from '../src/modules/cloudence/cloudence.constants';

const MIGRATION_ID = 'cloudence-private-storage-v1';
const LEASE_MS = 35 * 60_000;

export async function migrateCloudencePrivate(options: { apply: boolean; limit?: number; once?: boolean }) {
  const { apply, once = false } = options;
  const limit = options.limit ?? Infinity;
  if (!(limit > 0) || (limit !== Infinity && !Number.isSafeInteger(limit))) throw new Error('Use a positive integer for --limit.');
  if (once && (!apply || limit !== Infinity)) throw new Error('--once requires --apply without --limit.');
  const db = new FirebaseAdminService().db();
  const state = db.collection('systemMigrations').doc(MIGRATION_ID);
  if (apply) {
    const migration = (await state.get()).data();
    if (migration?.completedAt || (once && migration?.automaticAttemptedAt)) {
      console.log('Cloudence migration already completed or automatically attempted; skipping file scan.');
      return 0;
    }
  }
  if (apply) assertCloudinaryConfigured();
  cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });
  const runId = randomUUID();
  let lastRenewal = Date.now();
  if (apply) {
    const acquired = await db.runTransaction(async (transaction) => {
      const migration = (await transaction.get(state)).data();
      if (migration?.completedAt || (once && migration?.automaticAttemptedAt)) return false;
      if (migration?.leaseUntil > Date.now()) throw new Error('Cloudence migration is already running; try again after it finishes or its lease expires.');
      transaction.set(state, {
        runId, leaseUntil: Date.now() + LEASE_MS,
        // Persist before asset changes so failures and timeouts cannot trigger another automatic run.
        ...(once ? { automaticAttemptedAt: FieldValue.serverTimestamp() } : {}),
      }, { merge: true });
      return true;
    });
    if (!acquired) return 0;
  }
  try {
    let cursor: string | undefined;
    let selected = 0;
    let protectedFiles = 0;
    let cachedLinks = 0;
    while (selected < limit) {
      let query = db.collection(COLLECTION).orderBy(FieldPath.documentId()).limit(Math.min(100, limit - selected));
      if (cursor) query = query.startAfter(cursor);
      const batch = await query.get();
      if (batch.empty) break;
      for (const document of batch.docs) {
        cursor = document.id;
        const file = document.data();
        if (file.deliveryType === 'authenticated' && !file.privateMigration) continue;
        if (selected >= limit) break;
        if (!file.publicId?.startsWith(`chefu/cloudence/${file.ownerId}/`) || !['image', 'video', 'raw'].includes(file.resourceType)) {
          throw new Error(`Unexpected asset scope for document ${document.id}; migration stopped.`);
        }
        selected++;
        if (!apply) continue;
        if (Date.now() - lastRenewal >= 60_000) {
          await db.runTransaction(async (transaction) => {
            if ((await transaction.get(state)).data()?.runId !== runId) throw new Error('Cloudence migration lease was lost.');
            transaction.set(state, { leaseUntil: Date.now() + LEASE_MS }, { merge: true });
          });
          lastRenewal = Date.now();
        }
        // Persist the target before changing Cloudinary so interrupted runs can resume safely.
        let plan = file.privateMigration as { source: string; target: string; oldUrls: string[] } | undefined;
        if (!plan) {
          const signed = cloudinary.url(file.publicId, { sign_url: true, secure: true, type: 'upload', resource_type: file.resourceType, ...(file.resourceType !== 'raw' ? { format: file.extension } : {}) });
          plan = { source: file.publicId, target: `chefu/cloudence/${file.ownerId}/protected_${randomUUID()}`, oldUrls: [...new Set([file.url, file.signedUrl, signed].filter((value): value is string => typeof value === 'string' && value.startsWith('https://res.cloudinary.com/')))] };
          await document.ref.set({ privateMigration: plan }, { merge: true });
        }
        let asset;
        if (file.deliveryType === 'authenticated') {
          // Retrying CDN revocation must not rename the asset or rewrite its ledger again.
          asset = { public_id: file.publicId, type: 'authenticated', secure_url: file.url };
        } else try {
          asset = await cloudinary.uploader.rename(plan.source, plan.target, { resource_type: file.resourceType, type: 'upload', to_type: 'authenticated', overwrite: false, invalidate: true });
        } catch (error) {
          // Recovery is allowed only if the persisted protected target actually exists.
          try { asset = await cloudinary.api.resource(plan.target, { resource_type: file.resourceType, type: 'authenticated' }); }
          catch { throw error; }
        }
        if (asset.public_id !== plan.target || (asset.type && asset.type !== 'authenticated')) throw new Error('Cloudinary returned an unexpected migration target.');
        if (file.deliveryType !== 'authenticated') {
          await document.ref.set({ publicId: plan.target, deliveryType: 'authenticated', url: asset.secure_url, signedUrl: FieldValue.delete(), protectedAt: FieldValue.serverTimestamp() }, { merge: true });
          protectedFiles++;
        }
        // Renaming alone cannot prove that already-cached public CDN links were revoked.
        let oldLinkWorks = false;
        for (const url of plan.oldUrls) {
          const response = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
          const status = response.status;
          await response.body?.cancel();
          if (status !== 401 && status !== 403 && status !== 404 && status !== 410) oldLinkWorks = true;
        }
        if (oldLinkWorks) {
          cachedLinks++;
          console.warn(`Document ${document.id}: an old CDN link still responds. Cloudinary signed-URL invalidation is required; rerun after propagation.`);
        } else {
          await document.ref.set({ privateMigration: FieldValue.delete(), publicLinksRevokedAt: FieldValue.serverTimestamp() }, { merge: true });
        }
      }
    }
    console.log(JSON.stringify({ apply, selected, protectedFiles, pendingCdnRevocation: cachedLinks }));
    if (!apply) console.log('Dry run only. Deploy the protected-content endpoint before running with --apply.');
    if (apply && limit === Infinity && !cachedLinks) {
      await db.runTransaction(async (transaction) => {
        if ((await transaction.get(state)).data()?.runId !== runId) throw new Error('Cloudence migration lease was lost.');
        transaction.set(state, { completedAt: FieldValue.serverTimestamp() }, { merge: true });
      });
    }
    if (once) await state.set({ automaticFinishedAt: FieldValue.serverTimestamp(), automaticExitCode: cachedLinks ? 2 : 0 }, { merge: true });
    return cachedLinks ? 2 : 0;
  } finally {
    if (apply) await db.runTransaction(async (transaction) => {
      if ((await transaction.get(state)).data()?.runId === runId) {
        transaction.set(state, { runId: FieldValue.delete(), leaseUntil: FieldValue.delete() }, { merge: true });
      }
    });
  }
}

if (require.main === module) {
  const configuredLimit = process.argv.find((arg) => arg.startsWith('--limit='))?.slice(8);
  migrateCloudencePrivate({ apply: process.argv.includes('--apply'), once: process.argv.includes('--once'), ...(configuredLimit !== undefined ? { limit: Number(configuredLimit) } : {}) })
    .then((code) => { process.exitCode = code; })
    .catch((error) => { console.error(error instanceof Error ? error.message : 'Migration failed'); process.exitCode = 1; });
}
