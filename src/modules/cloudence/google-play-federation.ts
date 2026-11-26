import { request } from 'node:http';
import { IdentityPoolClient } from 'google-auth-library';
import type { GooglePlayFederationConfig } from './google-play-auth.config';

const FLY_API_SOCKET = '/.fly/api';
const MAX_TOKEN_BYTES = 16 * 1024;
const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

/** Fly returns a raw JWT. Google verifies its signature and mapped identity. */
export function requestFlyIdentityToken(
  audience: string,
  socketPath = FLY_API_SOCKET,
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ aud: audience });
    const req = request({
      socketPath,
      hostname: 'localhost',
      path: '/v1/tokens/oidc',
      method: 'POST',
      agent: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      signal: AbortSignal.timeout(timeoutMs),
    }, (res) => {
      res.on('error', () => reject(new Error('Fly workload identity is unavailable.')));
      res.on('aborted', () => reject(new Error('Fly workload identity is unavailable.')));
      if (res.statusCode !== 200) {
        // Never include the local API response or a token in errors or logs.
        res.resume();
        reject(new Error('Fly workload identity is unavailable.'));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      res.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_TOKEN_BYTES) {
          reject(new Error('Invalid Fly workload identity response.'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const token = Buffer.concat(chunks).toString('utf8').trim();
        if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
          reject(new Error('Invalid Fly workload identity response.'));
          return;
        }
        resolve(token);
      });
    });
    req.on('error', () => reject(new Error('Fly workload identity is unavailable.')));
    req.end(body);
  });
}

export function createGooglePlayFederatedClient(config: GooglePlayFederationConfig) {
  return new IdentityPoolClient({
    audience: config.audience,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url:
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(config.serviceAccountEmail)}:generateAccessToken`,
    scopes: [ANDROID_PUBLISHER_SCOPE],
    subject_token_supplier: {
      getSubjectToken: () => requestFlyIdentityToken(config.audience),
    },
  });
}
