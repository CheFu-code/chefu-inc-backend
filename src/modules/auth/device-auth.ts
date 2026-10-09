import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export type DeviceAuthChallenge = {
  deviceCode: string;
  pollSecret: string;
  userCode: string;
  expiresAt: number;
  createdAt: number;
  verificationUri: string;
  intervalSeconds: number;
};

export type DeviceAuthSession = {
  deviceCode: string;
  userCode: string;
  status: 'pending' | 'approved' | 'expired' | 'denied';
  expiresAt: number;
  createdAt: number;
  uid?: string;
  email?: string;
  idToken?: string;
  credentialClaimedAt?: unknown;
};

export type DeviceAuthPollRecord = {
  status?: string;
  token?: string;
  idToken?: string;
  email?: string;
  credentialClaimedAt?: unknown;
};

const DEVICE_CODE_BYTES = 24;
const USER_CODE_LENGTH = 8;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_INTERVAL_SECONDS = 5;

export function buildDeviceAuthChallenge(): DeviceAuthChallenge {
  const now = Date.now();
  const deviceCode = `chefu_${randomBytes(DEVICE_CODE_BYTES).toString('hex')}`;
  const pollSecret = randomBytes(32).toString('base64url');
  const userCode = buildUserCode();
  const verificationUri = new URL(`${process.env.CHEFU_ACCOUNT_URL || 'https://myaccount.chefu.co.za'}/device`);
  verificationUri.searchParams.set('deviceCode', deviceCode);
  verificationUri.searchParams.set('code', userCode);

  return {
    deviceCode,
    pollSecret,
    userCode,
    expiresAt: now + DEFAULT_TTL_MS,
    createdAt: now,
    verificationUri: verificationUri.toString(),
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
  };
}

export function normalizeDeviceCode(value: string | undefined): string {
  return (value || '').trim().toLowerCase().replace(/^chefu-/, '').replace(/[^a-z0-9]/g, '');
}

export function hashDevicePollSecret(pollSecret: string) {
  return createHash('sha256').update(pollSecret).digest('hex');
}

export function matchesDevicePollSecret(pollSecret: string, expectedHash: string) {
  const expected = Buffer.from(expectedHash, 'hex');
  const supplied = Buffer.from(hashDevicePollSecret(pollSecret), 'hex');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function resolveDeviceAuthPollResult(record: DeviceAuthPollRecord) {
  if (record.status !== 'approved') {
    return { kind: 'waiting' as const, status: record.status || 'pending' };
  }
  if (record.credentialClaimedAt) {
    return { kind: 'claimed' as const, status: 'claimed' as const };
  }
  return {
    kind: 'approved' as const,
    status: 'approved' as const,
    email: record.email || null,
    token: record.token || record.idToken || null,
  };
}

export function isTrustedDeviceInvalidatedByCredentialChange(
  deviceCreatedAtMs: number,
  credentialsValidAfterMs: number,
) {
  return deviceCreatedAtMs < credentialsValidAfterMs;
}

export function isDeviceAuthExpired(input: { createdAt: number; expiresAt: number }) {
  return Date.now() > input.expiresAt;
}

function buildUserCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';

  for (let index = 0; index < USER_CODE_LENGTH; index += 1) {
    result += alphabet[randomInt(alphabet.length)];
  }

  return `CHEFU-${result}`;
}
