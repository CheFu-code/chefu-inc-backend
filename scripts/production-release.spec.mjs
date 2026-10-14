import assert from 'node:assert/strict';
import test from 'node:test';
import { runProductionRelease } from './production-release.mjs';

test('release invokes the compiled migration with production environment and --apply', () => {
  const code = runProductionRelease((command, args, options) => {
    assert.equal(command, process.execPath);
    assert.match(args[0], /dist-migrations[/\\]scripts[/\\]migrate-cloudence-private\.js$/);
    assert.equal(args[1], '--apply');
    assert.equal(args[2], '--once');
    assert.equal(options.env, process.env);
    assert.equal(options.stdio, 'inherit');
    return { status: 0 };
  });
  assert.equal(code, 0);
});

test('pending CDN revocation allows deployment but migration errors stop it', () => {
  assert.equal(runProductionRelease(() => ({ status: 2 })), 0);
  assert.equal(runProductionRelease(() => ({ status: 1 })), 1);
  assert.equal(runProductionRelease(() => ({ status: null, signal: 'SIGTERM' })), 1);
  assert.equal(runProductionRelease(() => ({ status: null, error: new Error('Spawn failed') })), 1);
});
