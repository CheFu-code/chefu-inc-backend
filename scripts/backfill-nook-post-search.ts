import { FirebaseAdminService } from '../src/modules/firebase-admin/firebase-admin.service';
import { postSearchTokens } from '../src/modules/nook-messaging/post-search';

async function main() {
  const db = new FirebaseAdminService().db();
  try {
    const posts = db.collection('nookSocialPosts');
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    let scanned = 0;
    let updated = 0;

    while (true) {
      let query: FirebaseFirestore.Query = posts.orderBy('createdAt', 'desc').limit(400);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;

      const batch = db.batch();
      let pageUpdated = 0;
      for (const document of page.docs) {
        scanned += 1;
        if (Array.isArray(document.get('searchTokens'))) continue;
        batch.update(document.ref, {
          searchTokens: postSearchTokens(String(document.get('caption') || '')),
        });
        updated += 1;
        pageUpdated += 1;
      }

      if (pageUpdated) await batch.commit();
      cursor = page.docs.at(-1);
      console.info(`Scanned ${scanned} posts; indexed ${updated}.`);
      if (page.size < 400) break;
    }
  } finally {
    await db.terminate();
  }
}

void main().catch(error => {
  console.error('Failed to backfill Nook post search tokens.', error);
  process.exitCode = 1;
});
