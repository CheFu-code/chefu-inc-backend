import type { Request } from 'express';
import type { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

type Profile = Record<string, unknown>;
const requestReads = new WeakMap<Request, Map<string, Promise<Profile>>>();

// Authentication and authorization can need the same profile. Share that read
// only within one HTTP request, keyed by identity. The next request reads fresh
// roles; neither permission decisions nor database failures survive a request.
export function readAuthUserProfile(
  firebase: FirebaseAdminService,
  email: string,
  request?: Request,
): Promise<Profile> {
  const load = async (): Promise<Profile> => {
    const snapshot = await firebase.db().collection('users').doc(email).get();
    return snapshot.data() || {};
  };
  if (!request) return load();
  let reads = requestReads.get(request);
  if (!reads) {
    reads = new Map();
    requestReads.set(request, reads);
  }
  let pending = reads.get(email);
  if (!pending) {
    pending = load();
    reads.set(email, pending);
  }
  return pending;
}
