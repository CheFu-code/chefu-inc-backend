import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetadataScanner } from '@nestjs/core/metadata-scanner';
import { AuthSessionRoutes } from './auth-session.routes';
import { ACCOUNT_SESSION_SLOT_COUNT, accountSessionSlotCookieName, accountSessionSlotMetaCookieName } from './session.constants';

function setup() {
  const controller: any = Object.create(AuthSessionRoutes.prototype);
  const cookies: Record<string, string> = {};
  const identities = new Map<string, { uid: string; email: string }>();
  const checks: string[] = [], lookups: string[] = [], writes: string[] = [];
  const response: any = {
    cookie(name: string, value: string) { cookies[name] = value; writes.push(name); },
    clearCookie(name: string) { delete cookies[name]; writes.push(name); },
  };
  Object.assign(controller, {
    getCookieOptions: () => ({ path: '/', httpOnly: true }),
    getUserProfile: async () => ({}),
    clearCurrentSessionCookies() { response.clearCookie('__session'); response.clearCookie('__session_meta'); },
    sessionSigner: { verify: (raw: string) => {
      const identity = identities.get(raw?.replace(/^meta:/, ''));
      return identity ? { ...identity, name: identity.uid } : null;
    } },
    firebaseAdmin: { auth: () => ({
      verifySessionCookie: async (cookie: string, revoked: boolean) => {
        assert.equal(revoked, true);
        checks.push(cookie);
        const identity = identities.get(cookie);
        if (!identity) throw new Error('Expired or revoked session');
        return identity;
      },
      getUser: async (uid: string) => { lookups.push(uid); return { displayName: uid }; },
    }) },
  });
  function token(uid: string, suffix = '', email = `${uid}@example.test`) {
    const cookie = `${uid}:${suffix}`;
    identities.set(cookie, { uid, email }); return cookie;
  }
  const alice = token('alice'), bob = token('bob'), carol = token('carol');
  function active(cookie: string) { cookies.__session = cookie; cookies.__session_meta = `meta:${cookie}`; }
  function saved(slot: number, cookie: string) {
    cookies[accountSessionSlotCookieName(slot)] = cookie;
    cookies[accountSessionSlotMetaCookieName(slot)] = `meta:${cookie}`;
  }
  const request = () => ({ cookies: { ...cookies } });
  const list = async () => (await controller.listAccounts(request())).accounts as Array<{ email: string; slot: number | null; active: boolean }>;
  return {
    controller, cookies, identities, checks, lookups, writes, response, request, token, active, saved, list, alice, bob, carol,
    async login(cookie: string) {
      await controller.preserveActiveAccountSession(request(), response, identities.get(cookie)!.uid);
      active(cookie);
    },
    switch: (slot: number) => controller.switchAccount({ slot }, request(), response),
  };
}

void test('legacy duplicate cookies produce one chooser row per verified UID, with the active account first', async () => {
  const h = setup(), aliceOld = h.token('alice', 'old'), bobOther = h.token('bob', 'other');
  h.active(h.alice);
  h.saved(0, aliceOld); h.saved(1, h.bob); h.saved(2, bobOther); h.saved(3, h.bob); h.saved(4, h.carol);
  h.saved(5, 'expired');
  const accounts = await h.list();
  assert.deepEqual(accounts.map(account => [account.email, account.slot, account.active]), [
    ['alice@example.test', null, true], ['bob@example.test', 1, false], ['carol@example.test', 4, false],
  ]);
  assert.equal(h.checks.filter(cookie => cookie === h.bob).length, 1, 'identical cookies share request-local verification');
  assert.equal(h.lookups.length, 0, 'signed display metadata avoids extra user reads');
  assert.equal(h.writes.length, 0, 'the list remains read-only');
});

void test('password re-login to a saved account, then twenty switches back and forth, never creates duplicate slots', async () => {
  const h = setup(); h.active(h.alice);
  await h.login(h.bob);
  assert.equal(h.cookies.__session_account_0, h.alice);
  const aliceNew = h.token('alice', 'new-session');
  await h.login(aliceNew);
  assert.equal(h.cookies.__session, aliceNew);
  for (let turn = 0; turn < 20; turn++) {
    const accounts = await h.list();
    assert.equal(accounts.length, 2);
    assert.equal(new Set(accounts.map(account => account.email)).size, 2);
    const inactive = accounts.find(account => !account.active)!;
    assert.notEqual(inactive.slot, null);
    await h.switch(inactive.slot!);
    const saved = Array.from({ length: ACCOUNT_SESSION_SLOT_COUNT }, (_, slot) => h.cookies[accountSessionSlotCookieName(slot)]).filter(Boolean);
    assert.equal(saved.length, 1);
    assert.notEqual(h.identities.get(saved[0])!.uid, h.identities.get(h.cookies.__session)!.uid);
  }
});

void test('switching heals existing duplicates of both accounts and retains unrelated saved sessions', async () => {
  const h = setup(); h.active(h.alice);
  h.saved(0, h.alice); h.saved(1, h.bob); h.saved(2, h.token('bob', 'other'));
  h.saved(3, h.carol); h.saved(4, h.token('carol', 'other')); h.saved(5, 'unavailable');
  await h.switch(1);
  assert.equal(h.cookies.__session, h.bob);
  assert.equal(h.cookies.__session_account_1, h.alice);
  assert.equal(h.cookies.__session_account_3, h.carol);
  for (const slot of [0, 2, 4]) {
    assert.equal(h.cookies[accountSessionSlotCookieName(slot)], undefined);
    assert.equal(h.cookies[accountSessionSlotMetaCookieName(slot)], undefined);
  }
  assert.equal(h.cookies.__session_account_5, 'unavailable', 'temporary verification failures must not erase unrelated sign-ins');
  assert.equal(h.checks.filter(cookie => cookie === h.bob).length, 1, 'target verification is reused during reconciliation');
  assert.equal((await h.list()).length, 3);
});

void test('same-user selection and signing in without an active cookie remove old copies of the new active UID', async () => {
  const h = setup(); h.active(h.alice); h.saved(0, h.token('alice', 'old')); h.saved(1, h.bob);
  await h.switch(0);
  assert.equal(h.cookies.__session_account_0, undefined);
  assert.equal(h.cookies.__session_account_1, h.bob);
  delete h.cookies.__session; delete h.cookies.__session_meta;
  h.saved(2, h.bob); await h.login(h.bob);
  assert.equal((await h.list()).length, 1);
  assert.equal(h.cookies.__session_account_1, undefined);
  assert.equal(h.cookies.__session_account_2, undefined);
});

void test('removing a saved account removes all verified copies, without signing out the active or unrelated account', async () => {
  const h = setup(); h.active(h.alice); h.saved(0, h.bob); h.saved(1, h.token('bob', 'other')); h.saved(2, h.carol);
  await h.controller.removeAccount('0', h.response, h.request());
  assert.equal(h.cookies.__session, h.alice);
  assert.equal(h.cookies.__session_account_2, h.carol);
  assert.equal(h.cookies.__session_account_0, undefined);
  assert.equal(h.cookies.__session_account_1, undefined);
  assert.deepEqual((await h.list()).map(account => account.email), ['alice@example.test', 'carol@example.test']);
});

void test('identity comes from verified UIDs rather than display metadata or email labels', async () => {
  const h = setup(); h.active(h.alice);
  h.saved(0, h.token('different-uid', 'same-label', 'alice@example.test'));
  h.cookies.__session_account_meta_0 = `meta:${h.alice}`;
  const accounts = await h.list();
  assert.equal(accounts.length, 2);
  assert.equal(h.lookups.length, 1, 'mismatched display metadata cannot change the verified saved identity');
});

void test('Nest discovers account and authentication handlers across the smaller route classes', () => {
  const methods = new MetadataScanner().getAllMethodNames(AuthSessionRoutes.prototype);
  for (const [method, path] of [
    ['listAccounts', 'accounts'], ['switchAccount', 'accounts/switch'], ['removeAccount', 'accounts/:slot'],
    ['createSession', 'session'], ['createPasswordSession', 'session/password'], ['completePasswordMfaSession', 'session/mfa'],
    ['verifyPasskeySession', 'passkey/session/verify'], ['getSessionStatus', 'session/status'], ['clearSession', 'session'],
  ]) {
    assert.ok(methods.includes(method), method);
    assert.equal(Reflect.getMetadata('path', (AuthSessionRoutes.prototype as any)[method]), path);
  }
});
