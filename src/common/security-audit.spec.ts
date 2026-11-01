import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { sanitizeUrlForAudit } from './security-audit';
import { RequestLoggerMiddleware } from './request-logger.middleware';

test('audit routes never log passwords, OAuth state, tokens or arbitrary queries', () => {
  const path = sanitizeUrlForAudit('/auth/session/password?password=hunter2&state=secret&new_unknown_key=pii');
  assert.equal(path, '/auth/session/password');
  assert.equal(sanitizeUrlForAudit('/search?q=alice%40example.com'), '/search');
});

test('audit routes redact path secrets and cap untrusted lengths', () => {
  assert.equal(sanitizeUrlForAudit('/recover/' + 'a'.repeat(64) + '?code=123'), '/recover/[opaque-id]');
  assert.ok((sanitizeUrlForAudit('/' + 'a'.repeat(800)) || '').length <= 512);
  assert.equal(sanitizeUrlForAudit('not a valid url?foo=bar'), '/not%20a%20valid%20url');
});

test('request IDs from untrusted headers are bounded and cannot inject log data', () => {
  const middleware = new RequestLoggerMiddleware() as any;
  const output: Record<string, string> = {};
  const logs: string[] = [];
  middleware.logger = { log: (value: string) => logs.push(value) };
  const req: any = {
    headers: { 'x-request-id': 'malicious\nline'.repeat(100) },
    originalUrl: '/auth/me?token=secret',
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res: any = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: (name: string, value: string) => { output[name] = value; },
  });
  let nextCalls = 0;
  middleware.use(req, res, () => { nextCalls++; });
  assert.equal(nextCalls, 1);
  assert.match(output['x-request-id'], /^[0-9a-f-]{36}$/);
  res.emit('finish');
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes('secret'));
  assert.ok(!logs[0].includes('malicious'));
});
