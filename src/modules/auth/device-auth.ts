import { randomBytes } from 'node:crypto';

export type DeviceAuthChallenge = {
  deviceCode: string;
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
};

const DEVICE_CODE_BYTES = 24;
const USER_CODE_LENGTH = 8;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_INTERVAL_SECONDS = 5;

export function buildDeviceAuthChallenge(): DeviceAuthChallenge {
  const now = Date.now();
  const deviceCode = `chefu_${randomBytes(DEVICE_CODE_BYTES).toString('hex')}`;
  const userCode = buildUserCode();
  const verificationUri = new URL(`${process.env.CHEFU_ACCOUNT_URL || 'https://myaccount.chefu.co.za'}/device`);
  verificationUri.searchParams.set('deviceCode', deviceCode);
  verificationUri.searchParams.set('code', userCode);

  return {
    deviceCode,
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

export function isDeviceAuthExpired(input: { createdAt: number; expiresAt: number }) {
  return Date.now() > input.expiresAt;
}

function buildUserCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';

  for (let index = 0; index < USER_CODE_LENGTH; index += 1) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  return `CHEFU-${result}`;
}
