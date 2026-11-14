import { createHash } from 'node:crypto';
import { FieldPath, FieldValue } from 'firebase-admin/firestore';
import type { FirebaseAdminService } from '../src/modules/firebase-admin/firebase-admin.service';
import { normalizeContactPhone, phoneContact } from '../src/modules/auth/phone-contact';

type Row = Record<string, unknown>;
export function planPhoneMigration(profile: Row, uid: string | null, receipt: Row | null) {
  const raw = typeof profile.phone === 'string' ? profile.phone.trim() : '';
  const legacy = typeof profile.phoneNumber === 'string' ? profile.phoneNumber.trim() : '';
  const canonical = normalizeContactPhone(raw), alias = normalizeContactPhone(legacy);
  const conflict = !!raw && !!legacy && (canonical || raw) !== (alias || legacy);
  const phone = canonical || raw || alias || legacy || null;
  const existing = phoneContact(profile);
  const receiptContact = profile.phoneContactSchemaVersion !== 1 && receipt?.uid === uid && receipt?.provider === 'twilio-verify'
    ? phoneContact({ phone, phoneVerifiedFor: receipt.phone, phoneVerifiedAt: receipt.verifiedAt }) : null;
  const verifiedAt = !conflict && (existing.phoneVerifiedAt || receiptContact?.phoneVerifiedAt) || null;
  const fields: Row = { phone, phoneVerifiedAt: verifiedAt, phoneVerifiedFor: verifiedAt ? phone : null,
    phoneContactSchemaVersion: 1, phoneMigrationConflict: conflict };
  const changed = Object.entries(fields).some(([key, value]) => profile[key] !== value)
    || !conflict && Object.hasOwn(profile, 'phoneNumber');
  return { fields, changed, conflict, invalid: !!phone && !normalizeContactPhone(phone), removeAlias: !conflict };
}

export async function migratePhoneContacts(firebase: FirebaseAdminService, apply = false) {
  const db = firebase.db();
  const result = { apply, scanned: 0, changed: 0, conflicts: 0, invalid: 0, identityMissing: 0 };
  let cursor: string | undefined;
  while (true) {
    let query = db.collection('users').orderBy(FieldPath.documentId()).limit(100);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    for (const document of page.docs) {
      result.scanned++;
      const profile = document.data();
      let uid = typeof profile.uid === 'string' && profile.uid ? profile.uid : null;
      // Legacy users without a UID are resolved only during this offline job.
      if (!uid) {
        try { uid = (await firebase.auth().getUserByEmail(document.id)).uid; }
        catch (cause) {
          if ((cause as { code?: string })?.code !== 'auth/user-not-found') throw cause;
          result.identityMissing++;
        }
      }
      const receiptRef = uid ? db.collection('phone_verification_verified').doc(createHash('sha256').update(uid).digest('hex')) : null;
      const plan = apply ? await db.runTransaction(async tx => {
        const latest = (await tx.get(document.ref)).data();
        if (!latest) return null;
        // Never reconcile a receipt against a changed identity.
        if (latest.uid && latest.uid !== uid) throw new Error('Account identity changed. Rerun migration.');
        const receipt = receiptRef ? (await tx.get(receiptRef)).data() || null : null;
        const next = planPhoneMigration(latest, uid, receipt);
        if (next.changed) tx.set(document.ref, { ...next.fields,
          ...(next.removeAlias ? { phoneNumber: FieldValue.delete() } : {}),
        }, { merge: true });
        return next;
      }) : planPhoneMigration(profile, uid, receiptRef ? (await receiptRef.get()).data() || null : null);
      if (plan?.changed) result.changed++;
      if (plan?.conflict) result.conflicts++;
      if (plan?.invalid) result.invalid++;
    }
    cursor = page.docs.at(-1)?.id;
  }
  return result;
}
