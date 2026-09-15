import { FieldValue } from 'firebase-admin/firestore';
import { FirebaseAdminService } from '../src/modules/firebase-admin/firebase-admin.service';
import { sanitizeFlowHtml } from '../src/modules/flow/flow-email-template';

const COLLECTION = 'flowMessages';
const BATCH_LIMIT = 500;
const MAX_DOCUMENTS = readLimit(process.argv);
const APPLY_CHANGES = process.argv.includes('--apply');

async function main() {
  const firebaseAdmin = new FirebaseAdminService();
  const snapshot = await firebaseAdmin.db().collection(COLLECTION).get();
  const candidates = snapshot.docs.filter(document => {
    const html = document.data().html;
    return typeof html === 'string' && sanitizeFlowHtml(html) !== html;
  });
  const documents = MAX_DOCUMENTS ? candidates.slice(0, MAX_DOCUMENTS) : candidates;

  console.log(
    JSON.stringify({
      apply: APPLY_CHANGES,
      collection: COLLECTION,
      scanned: snapshot.size,
      candidates: candidates.length,
      selected: documents.length,
    }),
  );

  if (!APPLY_CHANGES) {
    console.log('Dry run only. Re-run with --apply to update selected documents.');
    return;
  }

  for (let index = 0; index < documents.length; index += BATCH_LIMIT) {
    const batch = firebaseAdmin.db().batch();
    const chunk = documents.slice(index, index + BATCH_LIMIT);

    chunk.forEach(document => {
      const html = document.data().html;
      if (typeof html !== 'string') return;

      batch.update(document.ref, {
        html: sanitizeFlowHtml(html),
        htmlSanitizedAt: FieldValue.serverTimestamp(),
        htmlSanitizedVersion: 1,
      });
    });

    await batch.commit();
    console.log(`Updated ${Math.min(index + BATCH_LIMIT, documents.length)}/${documents.length}`);
  }
}

function readLimit(args: string[]) {
  const value = args.find(argument => argument.startsWith('--limit='))?.slice('--limit='.length);
  if (!value) return 0;

  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('--limit must be a positive integer.');
  }

  return limit;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
