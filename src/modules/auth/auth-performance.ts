import type { Response } from 'express';

type Stage =
  | 'password'
  | 'verify_token'
  | 'session_cookie'
  | 'profile_sync'
  | 'trusted_device'
  | 'profile_read';

// Request-local timings only: no extra database operations, persistent logs,
// credentials or identifiers. Security checks are still awaited normally.
export async function authStage<T>(
  response: Response,
  name: Stage,
  task: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await task();
  } finally {
    if (!response.headersSent && typeof response.setHeader === 'function') {
      const previous = typeof response.getHeader === 'function'
        ? response.getHeader('Server-Timing') : undefined;
      const timing = `${name};dur=${(performance.now() - started).toFixed(1)}`;
      response.setHeader('Server-Timing',
        typeof previous === 'string' ? `${previous}, ${timing}` : timing,
      );
    }
  }
}

// Informational email only. Do not use this for verification, revocation,
// account creation, or security/audit writes that must complete before success.
export function afterSuccessfulAuthResponse(
  response: Response,
  task: () => Promise<void>,
  onError: (error: unknown) => void,
) {
  const cancel = () => { response.removeListener('finish', finish); };
  const finish = () => {
    response.removeListener('close', cancel);
    if (response.statusCode < 200 || response.statusCode >= 300) return;
    void Promise.resolve().then(task).catch(onError);
  };
  if (response.destroyed) return;
  response.once('finish', finish);
  response.once('close', cancel);
}
