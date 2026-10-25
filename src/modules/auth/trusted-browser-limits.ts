import { createHash } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { getClientIp } from '../../common/security-audit';

// This optional UI hint must not create Firestore rate-counter writes.
// Budgets are per process, bounded in memory, and independent of entered email.
export class TrustedBrowserLimits {
    private readonly buckets = new LRUCache<string, { count: number; reset: number }>({ max: 5000, ttl: 60_000 });
    private database: { count: number; reset: number } | undefined;
    constructor(private readonly now = Date.now) { }
    reserve(key: string, maximum: number) {
        const now = this.now();
        const old = key === "database" ? this.database : this.buckets.get(key);
        const bucket = old && old.reset > now ? old : { count: 0, reset: now + 60_000 };
        if (bucket.count >= maximum) throw new HttpException({
            trusted: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.reset - now) / 1000)),
        }, HttpStatus.TOO_MANY_REQUESTS);
        bucket.count++;
        if (key === "database") this.database = bucket;
        else this.buckets.set(key, bucket, { ttl: bucket.reset - now });
    }
}
export const trustedBrowserLimits = new TrustedBrowserLimits();
export function isTrustedBrowserStatusRequest(request: Request) {
  // Nest/Express may strip a middleware mount path from request.path.
  const path = (request.originalUrl || request.path).split('?')[0];
  return request.method === 'POST' && path.replace(/\/+$/, '').toLowerCase() === '/auth/trusted-devices/status';
}
export function reserveTrustedBrowserRequest(request: Request) {
    const ip = createHash('sha256').update(getClientIp(request) || 'unknown').digest('hex');
    trustedBrowserLimits.reserve(`ip:${ip}`, 60);
}
