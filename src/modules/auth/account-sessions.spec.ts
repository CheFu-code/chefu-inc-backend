import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthSessionRoutes } from './auth-session.routes';

test('account loading verifies saved sessions concurrently and preserves picker order', async () => {
  const controller: any = Object.create(AuthSessionRoutes.prototype);
  const release = new Map<string, (value: { uid: string; email: string }) => void>();
  Object.assign(controller, {
    sessionSigner: { verify: () => null },
    firebaseAdmin: { auth: () => ({
      verifySessionCookie: (cookie: string, checkRevoked: boolean) => {
        assert.equal(checkRevoked, true);
        return new Promise(resolve => { release.set(cookie, resolve); });
      },
      getUser: async (uid: string) => ({ displayName: uid }),
    }) },
  });
  const pending = controller.listAccounts({
    user: { uid: 'current', email: 'current@example.test' },
    cookies: { __session_account_0: 'first', __session_account_1: 'second', __session_account_7: 'last' },
  });
  assert.deepEqual([...release.keys()], ['first', 'second', 'last'], 'all verifications start before any finishes');
  release.get('last')!({ uid: 'last', email: 'last@example.test' });
  release.get('second')!({ uid: 'second', email: 'second@example.test' });
  release.get('first')!({ uid: 'first', email: 'first@example.test' });
  const result = await pending;
  assert.deepEqual(result.accounts.map((account: { slot: number | null }) => account.slot), [null, 0, 1, 7]);
});

test('expired or revoked saved sessions fail switching before modifying any browser cookies', async () => {
  const controller: any = Object.create(AuthSessionRoutes.prototype);
  const writes: string[] = [];
  const response: any = {
    cookie: (name: string) => writes.push(name),
    clearCookie: (name: string) => writes.push(name),
  };
  controller.firebaseAdmin = { auth: () => ({ verifySessionCookie: async (_cookie: string, checkRevoked: boolean) => {
    assert.equal(checkRevoked, true);
    throw new Error('Saved account session expired or revoked');
  } }) };
  const request = { cookies: { __session: 'current-session', __session_meta: 'current-meta', __session_account_0: 'expired-session' } };
  await assert.rejects(controller.switchAccount({ slot: 0 }, request, response), /expired or revoked/);
  await assert.rejects(controller.switchAccount({ slot: 1 }, request, response), /empty/);
  assert.deepEqual(writes, []);
  assert.equal(request.cookies.__session, 'current-session');
});

test('a successful saved-account switch preserves the previous session for switching back', async () => {
  const controller: any = Object.create(AuthSessionRoutes.prototype);
  const cookies: Record<string, string> = {
    __session: 'alice-session', __session_meta: 'alice-meta',
    __session_account_0: 'bob-session', __session_account_meta_0: 'bob-meta',
  };
  const written: Record<string, string> = {};
  controller.getCookieOptions = () => ({ path: '/', httpOnly: true });
  controller.firebaseAdmin = { auth: () => ({ verifySessionCookie: async (cookie: string, revoked: boolean) => {
    assert.equal(cookie, 'bob-session');
    assert.equal(revoked, true);
    return { uid: 'bob', email: 'bob@example.test' };
  } }) };
  await controller.switchAccount({ slot: 0 }, { cookies }, {
    cookie: (name: string, value: string) => { written[name] = value; },
    clearCookie: () => assert.fail('valid session metadata must be preserved'),
  });
  assert.deepEqual(written, {
    __session_account_0: 'alice-session', __session_account_meta_0: 'alice-meta',
    __session: 'bob-session', __session_meta: 'bob-meta',
  });
});

test('account picker displays identity-matched metadata for current and saved accounts', async () => {
  const controller: any = Object.create(AuthSessionRoutes.prototype);
  const verified: string[] = [];
  Object.assign(controller, {
    sessionSigner: { verify: (value: string) => ({
      current: { uid: 'alice', email: 'alice@example.test', name: 'Alice', profilePicture: 'https://example.test/alice.jpg' },
      saved: { uid: 'bob', email: 'bob@example.test', name: 'Bob', profilePicture: 'https://example.test/bob.jpg' },
    }[value]) },
    firebaseAdmin: { auth: () => ({
      verifySessionCookie: async (cookie: string, revoked: boolean) => {
        assert.equal(revoked, true);
        verified.push(cookie);
        if (cookie === 'expired') throw new Error('expired');
        return { uid: 'bob', email: 'bob@example.test' };
      },
      getUser: () => assert.fail('matching display metadata requires no extra profile read'),
    }) },
  });
  const result = await controller.listAccounts({
    user: { uid: 'alice', email: 'alice@example.test' },
    cookies: { __session_meta: 'current', __session_account_0: 'bob-session', __session_account_meta_0: 'saved', __session_account_1: 'expired' },
  });
  assert.deepEqual(result.accounts, [
    { slot: null, email: 'alice@example.test', active: true, fullName: 'Alice', profilePicture: 'https://example.test/alice.jpg' },
    { slot: 0, email: 'bob@example.test', active: false, fullName: 'Bob', profilePicture: 'https://example.test/bob.jpg' },
  ]);
  assert.deepEqual(verified, ['bob-session', 'expired']);
});

test('mismatched metadata cannot supply another account identity; legacy sessions use verified user records', async () => {
  const controller: any = Object.create(AuthSessionRoutes.prototype);
  let fail = false;
  Object.assign(controller, {
    sessionSigner: { verify: () => ({ uid: 'other', email: 'other@example.test', name: 'Wrong person', profilePicture: 'wrong.jpg' }) },
    firebaseAdmin: { auth: () => ({ getUser: async (uid: string) => {
      assert.equal(uid, 'alice');
      if (fail) throw new Error('temporarily unavailable');
      return { displayName: 'Alice', photoURL: 'https://example.test/alice.jpg' };
    } }) },
  });
  const req = { user: { uid: 'alice', email: 'alice@example.test' }, cookies: {} };
  assert.equal((await controller.listAccounts(req)).accounts[0].fullName, 'Alice');
  fail = true;
  assert.deepEqual((await controller.listAccounts(req)).accounts, [{ slot: null, email: 'alice@example.test', active: true }]);
});

test('removing one saved account clears only its two cookies and rejects invalid slots', async () => {
  const controller: any = Object.create(AuthSessionRoutes.prototype);
  controller.getCookieOptions = () => ({ path: '/', httpOnly: true });
  const cleared: string[] = [];
  const response: any = { clearCookie: (name: string) => cleared.push(name) };
  assert.deepEqual(await controller.removeAccount('2', response), { ok: true });
  assert.deepEqual(cleared, ['__session_account_2', '__session_account_meta_2']);
  for (const slot of ['-1', '8', 'abc', '1.5']) {
    await assert.rejects(controller.removeAccount(slot, response), /Invalid account slot/);
  }
  assert.equal(cleared.length, 2);
});
