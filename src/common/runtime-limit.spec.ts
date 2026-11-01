import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeLimitService } from './runtime-limit.service';

function setupRedisFake() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let count = 0;
  let replayed = false;
  const redis = {
    status: 'ready',
    eval: async (...args: unknown[]) => {
      calls.push({ method: 'eval', args });
      return [++count, 1200];
    },
    set: async (...args: unknown[]) => {
      calls.push({ method: 'set', args });
      if (replayed) return null;
      replayed = true;
      return 'OK';
    },
  };
  const service = Object.create(RuntimeLimitService.prototype) as RuntimeLimitService;
  Object.assign(service, {
    store: 'redis', redis, redisConnection: null,
    logger: { log() {}, warn() {}, error() {} },
  });
  return { service, calls, redis };
}

test('Redis rate limiting is atomic, bounded and does not expose raw keys', async () => {
  const { service, calls } = setupRedisFake();
  const opts = { collection: 'runtime_auth_rate_limits', key: 'email:alice@example.test', limit: 2, windowMs: 2000 };
  const first = await service.reserve(opts);
  const second = await service.reserve(opts);
  const third = await service.reserve(opts);
  assert.equal(first.limited, false);
  assert.equal(first.remaining, 1);
  assert.equal(second.limited, false);
  assert.equal(second.remaining, 0);
  assert.equal(third.limited, true);
  assert.equal(third.remaining, 0);
  assert.equal(third.retryAfterSeconds, 2);
  assert.equal(calls.length, 3);
  const args = calls[0].args;
  assert.equal(args[1], 1);
  assert.match(String(args[2]), /^chefu:limits:runtime_auth_rate_limits:[a-f0-9]{64}$/);
  assert.equal(String(args[2]).includes('alice@example.test'), false);
  assert.equal(args[3], '2000');
});

test('Redis replay detection is first-writer-wins and expires automatically', async () => {
  const { service, calls } = setupRedisFake();
  assert.equal(await service.assertNotReplay('dpop:sensitive-proof', 120), true);
  assert.equal(await service.assertNotReplay('dpop:sensitive-proof', 120), false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'set');
  assert.match(String(calls[0].args[0]), /^chefu:replay:[a-f0-9]{64}$/);
  assert.deepEqual(calls[0].args.slice(1), ['1', 'EX', 120, 'NX']);
});

test('Unhealthy distributed storage never becomes a local security bypass by default', async () => {
  const { service, redis } = setupRedisFake();
  redis.eval = async () => { throw new Error('offline'); };
  await assert.rejects(service.reserve({ key: 'ip:127.0.0.1', limit: 2, windowMs: 2000 }),
    (error: unknown) => {
      assert.equal((error as { getStatus(): number }).getStatus(), 503);
      return true;
    });
});

test('Unexpected Redis replies fail closed instead of granting requests', async () => {
  const { service, redis } = setupRedisFake();
  redis.eval = async () => [0, -1];
  await assert.rejects(service.reserve({ key: 'ip:127.0.0.1', limit: 2, windowMs: 2000 }),
    (error: unknown) => {
      assert.equal((error as { getStatus(): number }).getStatus(), 503);
      return true;
    });
});
