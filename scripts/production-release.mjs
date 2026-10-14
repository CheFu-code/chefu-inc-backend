import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function runProductionRelease(run = spawnSync) {
  const migration = fileURLToPath(new URL('../dist-migrations/scripts/migrate-cloudence-private.js', import.meta.url));
  const result = run(process.execPath, [migration, '--apply', '--once'], { stdio: 'inherit', env: process.env });
  if (result.error || result.signal || result.status === null) {
    console.error('Cloudence migration could not finish. Deployment stopped.');
    return 1;
  }
  if (result.status === 2) {
    console.warn('Cloudence storage is protected, but old CDN links still need invalidation. Deployment will continue. No automatic retry; verify revocation manually after invalidation.');
    return 0;
  }
  return result.status === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runProductionRelease();
}
