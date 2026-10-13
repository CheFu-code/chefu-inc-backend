import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuantumAgentDataService } from './agent-data.service';
import { QuantumAgentSchedulesService } from './agent-schedules.service';
import { FirebaseAdminService } from '../../firebase-admin/firebase-admin.service';
import { nextRunAt } from './schedule-time';

function fixture() {
  const rows = new Map<string, any>();
  const ref = (path: string): any => ({
    path, id: path.split('/').at(-1),
    collection: (name: string) => collection(`${path}/${name}`),
    get: async () => ({ exists: rows.has(path), id: path.split('/').at(-1), data: () => rows.get(path) }),
    create: async (value: any) => { assert(!rows.has(path)); rows.set(path, value); },
    set: async (value: any) => { rows.set(path, value); },
  });
  const collection = (path: string): any => ({ doc: (id = 'generated') => ref(`${path}/${id}`) });
  const db = {
    collection,
    runTransaction: async (fn: any) => fn({
      get: (reference: any) => reference.get(),
      create: (reference: any, value: any) => { assert(!rows.has(reference.path)); rows.set(reference.path, value); },
      update: (reference: any, value: any) => { assert(rows.has(reference.path)); rows.set(reference.path, { ...rows.get(reference.path), ...value }); },
      set: (reference: any, value: any) => rows.set(reference.path, value),
    }),
    recursiveDelete: async (reference: any) => {
      for (const key of rows.keys()) if (key === reference.path || key.startsWith(reference.path + '/')) rows.delete(key);
    },
  };
  const firebase = { db: () => db } as unknown as FirebaseAdminService;
  return { rows, firebase, service: new QuantumAgentDataService(firebase) };
}
const alice = { uid: 'alice', email: 'alice@example.test', roles: [] };
const bob = { uid: 'bob', email: 'bob@example.test', roles: [] };

test('chat IDs never grant access to another user and deletion removes messages', async () => {
  const { service, rows } = fixture();
  await service.createThread(alice, { type: 'main', title: 'Alice' });
  await service.saveMessage(alice, 'main', { role: 'user', content: 'private', metadata: {} });
  await assert.rejects(service.getThread(bob, 'main'), /not found/);
  await assert.rejects(service.saveMessage(bob, 'main', { role: 'assistant', content: 'forged' }), /not found/);
  await assert.rejects(service.updateMessage(bob, 'main', 'generated', { content: 'forged' }), /not found/);
  await assert.rejects(service.deleteThread(bob, 'main'), /not found/);
  assert.equal(rows.size, 2);
  await service.deleteThread(alice, 'main');
  assert.equal(rows.size, 0);
});

test('main thread creation is idempotent and invalid paths/oversized content fail', async () => {
  const { service, rows } = fixture();
  const first = await service.createThread(alice, { type: 'main', title: 'First' });
  const second = await service.createThread(alice, { type: 'main', title: 'Second' });
  assert.deepEqual(first, second);
  assert.equal(rows.size, 1);
  await assert.rejects(service.getThread(alice, '../bob'), /Invalid identifier/);
  await assert.rejects(service.saveMessage(alice, 'main', { role: 'user', content: 'x'.repeat(30001) }), /Invalid message/);
});

test('schedules reject another user and concurrent execution before contacting the worker', async () => {
  const { service, rows, firebase } = fixture();
  const schedules = new QuantumAgentSchedulesService(firebase, service);
  rows.set('quantum_agent_schedules/task', { user_id: alice.uid, lease_until: Date.now() + 60000 });
  const oldUrl = process.env.QUANTUM_AGENT_WORKER_URL;
  const oldSecret = process.env.QUANTUM_AGENT_WORKER_SECRET;
  process.env.QUANTUM_AGENT_WORKER_URL = 'https://worker.example.test/api/scheduled-run';
  process.env.QUANTUM_AGENT_WORKER_SECRET = 'test-secret'.repeat(4);
  try {
    await assert.rejects(schedules.setStatus(bob, 'task', 'paused'), /not found/);
    await assert.rejects(schedules.run('task', bob), /not found/);
    await assert.rejects(schedules.run('task', alice), /already running/);
  } finally {
    if (oldUrl === undefined) delete process.env.QUANTUM_AGENT_WORKER_URL; else process.env.QUANTUM_AGENT_WORKER_URL = oldUrl;
    if (oldSecret === undefined) delete process.env.QUANTUM_AGENT_WORKER_SECRET; else process.env.QUANTUM_AGENT_WORKER_SECRET = oldSecret;
  }
});

test('schedule time uses the selected timezone, weekly day, and skips nonexistent DST times', () => {
  assert.equal(nextRunAt({ frequency: 'daily', time: '08:00' }, 'Africa/Johannesburg', new Date('2026-10-13T05:00:00Z')), '2026-10-13T06:00:00.000Z');
  assert.equal(nextRunAt({ frequency: 'weekly', time: '08:00', weekday: 'monday' }, 'Africa/Johannesburg', new Date('2026-10-13T05:00:00Z')), '2026-10-19T06:00:00.000Z');
  assert.equal(nextRunAt({ frequency: 'daily', time: '02:30' }, 'America/New_York', new Date('2026-03-08T06:00:00Z')), '2026-03-09T06:30:00.000Z');
  assert.throws(() => nextRunAt({ frequency: 'daily', time: '25:00' }, 'UTC'), /Invalid schedule/);
  assert.throws(() => nextRunAt({ frequency: 'daily', time: '08:00' }, 'Invalid/Timezone'), /timezone/);
});
