import type { Auth } from 'firebase-admin/auth';
import type { CookieOptions, Response } from 'express';
import { ACCOUNT_SESSION_SLOT_COUNT, accountSessionSlotCookieName, accountSessionSlotMetaCookieName } from './session.constants';

export type AccountIdentity = { uid: string; email: string };
type AccountCookie = { cookie: string; meta?: string; identity: AccountIdentity };
export type AccountSlot = { slot: number; cookie: string; meta?: string; identity: AccountIdentity | null };

// Request-local only: reuse verification of identical cookies, never cache authorization across requests.
export function accountSessionReader(auth: Pick<Auth, 'verifySessionCookie'>, known?: AccountCookie) {
  const pending = new Map<string, Promise<AccountIdentity | null>>();
  if (known) pending.set(known.cookie, Promise.resolve(known.identity));
  return (cookie: unknown): Promise<AccountIdentity | null> => {
    if (typeof cookie !== 'string' || !cookie) return Promise.resolve(null);
    let result = pending.get(cookie);
    if (!result) {
      result = auth.verifySessionCookie(cookie, true)
        .then(user => user.uid && user.email ? { uid: user.uid, email: user.email } : null)
        .catch(() => null);
      pending.set(cookie, result);
    }
    return result;
  };
}

export async function readAccountSlots(cookies: Record<string, unknown> | undefined, read: ReturnType<typeof accountSessionReader>) {
  const slots = await Promise.all(Array.from({ length: ACCOUNT_SESSION_SLOT_COUNT }, async (_, slot): Promise<AccountSlot | null> => {
    const cookie = cookies?.[accountSessionSlotCookieName(slot)];
    if (typeof cookie !== 'string' || !cookie) return null;
    const meta = cookies?.[accountSessionSlotMetaCookieName(slot)];
    return { slot, cookie, meta: typeof meta === 'string' ? meta : undefined, identity: await read(cookie) };
  }));
  return slots.filter((slot): slot is AccountSlot => slot !== null);
}

export function synchronizeAccountSlots(input: {
  slots: AccountSlot[]; activeUid: string; previous?: AccountCookie; preferredSlot?: number;
  response: Response; options: CookieOptions;
}) {
  const { slots, activeUid, previous, preferredSlot, response, options } = input;
  const seen = new Set([activeUid]);
  if (previous) seen.add(previous.identity.uid);
  const desired = new Map<number, { cookie: string; meta?: string }>();
  for (const saved of slots) {
    if (saved.identity) {
      if (seen.has(saved.identity.uid)) continue;
      seen.add(saved.identity.uid);
    }
    // A verification outage must not erase an unrelated saved sign-in.
    desired.set(saved.slot, saved);
  }
  if (previous && previous.identity.uid !== activeUid) {
    const existingSlot = slots.find(saved => saved.identity?.uid === previous.identity.uid)?.slot;
    const emptySlot = Array.from({ length: ACCOUNT_SESSION_SLOT_COUNT }, (_, slot) => slot).find(slot => !desired.has(slot));
    desired.set(preferredSlot ?? existingSlot ?? emptySlot ?? 0, previous);
  }
  const original = new Map(slots.map(saved => [saved.slot, saved]));
  for (let slot = 0; slot < ACCOUNT_SESSION_SLOT_COUNT; slot++) {
    const before = original.get(slot), after = desired.get(slot);
    if (!after) {
      if (before) {
        response.clearCookie(accountSessionSlotCookieName(slot), options);
        response.clearCookie(accountSessionSlotMetaCookieName(slot), options);
      }
      continue;
    }
    if (before?.cookie === after.cookie && before?.meta === after.meta) continue;
    response.cookie(accountSessionSlotCookieName(slot), after.cookie, options);
    if (after.meta) response.cookie(accountSessionSlotMetaCookieName(slot), after.meta, options);
    else response.clearCookie(accountSessionSlotMetaCookieName(slot), options);
  }
}
