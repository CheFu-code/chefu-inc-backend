import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { FirebaseAdminService } from '../modules/firebase-admin/firebase-admin.service';

type LimitOptions = {
  collection?: string;
  key: string;
  limit: number;
  windowMs: number;
};

type LimitResult = {
  limited: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
};

@Injectable()
export class RuntimeLimitService {
  private readonly logger = new Logger(RuntimeLimitService.name);
  private readonly localLimitBuckets = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private readonly localReplayBuckets = new Map<string, number>();
  private readonly useFirestore =
    process.env.RUNTIME_LIMIT_STORE !== 'memory' &&
    process.env.NODE_ENV !== 'test';

  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

  async reserve(options: LimitOptions): Promise<LimitResult> {
    const safeLimit = Math.max(1, Math.floor(options.limit));
    const safeWindowMs = Math.max(1_000, Math.floor(options.windowMs));

    if (!this.useFirestore) {
      return this.reserveLocal({
        ...options,
        limit: safeLimit,
        windowMs: safeWindowMs,
      });
    }

    try {
      return await this.reserveFirestore({
        ...options,
        limit: safeLimit,
        windowMs: safeWindowMs,
      });
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'runtime_limit_store_fallback',
          reason: error instanceof Error ? error.message : 'unknown',
        }),
      );
      return this.reserveLocal({
        ...options,
        limit: safeLimit,
        windowMs: safeWindowMs,
      });
    }
  }

  async assertNotReplay(key: string, ttlSeconds: number) {
    const safeTtlSeconds = Math.max(1, Math.floor(ttlSeconds));

    if (!this.useFirestore) {
      return this.assertNotReplayLocal(key, safeTtlSeconds);
    }

    try {
      return await this.assertNotReplayFirestore(key, safeTtlSeconds);
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'runtime_replay_store_fallback',
          reason: error instanceof Error ? error.message : 'unknown',
        }),
      );
      return this.assertNotReplayLocal(key, safeTtlSeconds);
    }
  }

  private async reserveFirestore(options: Required<LimitOptions>) {
    const now = Date.now();
    const ref = this.firebaseAdmin
      .db()
      .collection(options.collection)
      .doc(this.keyHash(options.key));

    return this.firebaseAdmin.db().runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      const data = snapshot.data() as
        | { count?: number; resetAtMs?: number }
        | undefined;
      const resetAt =
        snapshot.exists && Number(data?.resetAtMs || 0) > now
          ? Number(data?.resetAtMs)
          : now + options.windowMs;
      const count =
        snapshot.exists && Number(data?.resetAtMs || 0) > now
          ? Number(data?.count || 0) + 1
          : 1;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((resetAt - now) / 1000),
      );

      tx.set(
        ref,
        {
          count,
          expiresAt: Timestamp.fromMillis(resetAt + 60_000),
          keyHash: this.keyHash(options.key),
          resetAtMs: resetAt,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return {
        limited: count > options.limit,
        remaining: Math.max(0, options.limit - count),
        resetAt,
        retryAfterSeconds,
      };
    });
  }

  private reserveLocal(options: Required<LimitOptions>) {
    const now = Date.now();
    const key = `${options.collection}:${options.key}`;
    const current = this.localLimitBuckets.get(key);
    const bucket =
      current && current.resetAt > now
        ? current
        : { count: 0, resetAt: now + options.windowMs };

    bucket.count += 1;
    this.localLimitBuckets.set(key, bucket);
    this.pruneLocalLimitBuckets(now);

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((bucket.resetAt - now) / 1000),
    );

    return {
      limited: bucket.count > options.limit,
      remaining: Math.max(0, options.limit - bucket.count),
      resetAt: bucket.resetAt,
      retryAfterSeconds,
    };
  }

  private async assertNotReplayFirestore(key: string, ttlSeconds: number) {
    const now = Date.now();
    const expiresAtMs = now + ttlSeconds * 1000;
    const ref = this.firebaseAdmin
      .db()
      .collection('runtime_replay_cache')
      .doc(this.keyHash(key));

    return this.firebaseAdmin.db().runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      const data = snapshot.data() as { expiresAtMs?: number } | undefined;

      if (snapshot.exists && Number(data?.expiresAtMs || 0) > now) {
        return false;
      }

      tx.set(ref, {
        expiresAt: Timestamp.fromMillis(expiresAtMs + 60_000),
        expiresAtMs,
        keyHash: this.keyHash(key),
        updatedAt: FieldValue.serverTimestamp(),
      });

      return true;
    });
  }

  private assertNotReplayLocal(key: string, ttlSeconds: number) {
    const now = Date.now();
    const expiresAt = this.localReplayBuckets.get(key) || 0;

    if (expiresAt > now) {
      return false;
    }

    this.localReplayBuckets.set(key, now + ttlSeconds * 1000);
    this.pruneLocalReplayBuckets(now);
    return true;
  }

  private pruneLocalLimitBuckets(now: number) {
    if (this.localLimitBuckets.size < 5_000) return;

    for (const [key, bucket] of this.localLimitBuckets.entries()) {
      if (bucket.resetAt <= now) this.localLimitBuckets.delete(key);
    }
  }

  private pruneLocalReplayBuckets(now: number) {
    if (this.localReplayBuckets.size < 5_000) return;

    for (const [key, expiresAt] of this.localReplayBuckets.entries()) {
      if (expiresAt <= now) this.localReplayBuckets.delete(key);
    }
  }

  private keyHash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}
