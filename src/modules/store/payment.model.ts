import { createHash } from 'node:crypto';
import type { OrderLine } from './checkout.validation';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export type PaymentState = 'PENDING' | 'INITIALIZED' | 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'EXPIRED' | 'REQUIRES_REVIEW';
export type StoreOrder = {
  reference: string; ownerHash: string; accountUid?: string; requestHash: string;
  delivery: Record<string, string>; lines: OrderLine[];
  currency: 'ZAR'; subtotalMinor: number; deliveryMinor: number; amountMinor: number;
  // Compatibility projection for the existing cart. Payment lifecycle is stored separately.
  status: 'initializing' | 'pending' | 'paid' | 'failed';
  stockReserved: boolean; accessCode?: string; initLeaseUntil: number;
  createdAt: number; updatedAt: number; reconcileAfter: number; termsAcceptedAt: number;
  schemaVersion?: number; paidAt?: number; fulfillmentStatus?: string;
};
export type PaymentRecord = {
  reference: string; orderId: string; state: PaymentState; version: number;
  initializationDispatched: boolean; accessCode?: string; providerId?: string;
  createdAt: number; updatedAt: number; expiresAt: number;
  verifiedAt?: number; verificationLease?: string; verificationLeaseUntil: number;
  nextVerificationAt: number; verificationAttempts: number; lastOutcome?: string;
};

const transitions: Record<PaymentState, readonly PaymentState[]> = {
  PENDING: ['INITIALIZED', 'PROCESSING', 'SUCCESS', 'FAILED', 'EXPIRED', 'REQUIRES_REVIEW'],
  INITIALIZED: ['PROCESSING', 'SUCCESS', 'FAILED', 'EXPIRED', 'REQUIRES_REVIEW'],
  PROCESSING: ['SUCCESS', 'FAILED', 'EXPIRED', 'REQUIRES_REVIEW'],
  FAILED: ['SUCCESS', 'REQUIRES_REVIEW'],
  EXPIRED: ['SUCCESS', 'FAILED', 'REQUIRES_REVIEW'],
  REQUIRES_REVIEW: ['SUCCESS', 'FAILED'],
  SUCCESS: [],
};
export function transitionPayment(current: PaymentRecord, state: PaymentState, now = Date.now()): PaymentRecord {
  if (current.state === state || current.state === 'SUCCESS') return current;
  if (!transitions[current.state].includes(state)) throw new Error(`Invalid payment transition: ${current.state} -> ${state}`);
  return { ...current, state, version: current.version + 1, updatedAt: now };
}

export function paymentFromOrder(order: StoreOrder): PaymentRecord {
  return {
    reference: order.reference, orderId: order.reference,
    state: order.status === 'paid' ? 'SUCCESS' : order.status === 'failed' ? 'FAILED' : order.accessCode ? 'INITIALIZED' : 'PROCESSING',
    version: 1, initializationDispatched: true,
    ...(order.accessCode ? { accessCode: order.accessCode } : {}),
    createdAt: order.createdAt, updatedAt: order.updatedAt, expiresAt: order.createdAt + 30 * 60_000,
    verificationLeaseUntil: 0, nextVerificationAt: 0, verificationAttempts: 0,
  };
}

export function backoff(attempt: number, random = Math.random) {
  return Math.min(6 * 60 * 60_000, Math.floor(15_000 * 2 ** Math.min(attempt, 12) * (0.75 + random() * 0.5)));
}

// Fail closed on imprecise JSON numbers: a rounded 64-bit ID cannot be a unique key.
export function providerIdentity(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : undefined;
}
