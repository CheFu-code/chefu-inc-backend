import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthSessionRoutes } from './auth-session.routes';

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
