import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
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
  private readonly store: 'memory' | 'firestore' | 'redis' =
    process.env.NODE_ENV === 'test' ? 'memory'
      : process.env.RUNTIME_LIMIT_STORE === 'firestore' ? 'firestore'
        : process.env.RUNTIME_LIMIT_STORE === 'redis' ? 'redis' : 'memory';
  private readonly redis: Redis | null;
  private redisConnection: Promise<void> | null = null;

  constructor(private readonly firebaseAdmin: FirebaseAdminService) {
    this.redis = this.store === 'redis' ? this.createRedisClient() : null;
    if (process.env.NODE_ENV === 'production' && this.store === 'memory') {
      this.logger.warn('Runtime limits are process-local. Set RUNTIME_LIMIT_STORE=redis or firestore before scaling to multiple instances.');
    }
  }

  private createRedisClient(): Redis {
    const connectionOptions = {
      lazyConnect: true,
      connectTimeout: 1500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    } as const;
    const url = process.env.RUNTIME_LIMIT_REDIS_URL || process.env.REDIS_URL;
    let client: Redis;
    if (url) {
      if (!['redis:', 'rediss:'].includes(new URL(url).protocol)) {
        throw new Error('RUNTIME_LIMIT_REDIS_URL must use redis:// or rediss://');
      }
      client = new Redis(url, connectionOptions);
    } else {
      if (!process.env.REDIS_HOST) {
        throw new Error('RUNTIME_LIMIT_STORE=redis requires REDIS_HOST or RUNTIME_LIMIT_REDIS_URL');
      }
      client = new Redis({
        ...connectionOptions,
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        db: Number(process.env.REDIS_DB || 0),
      });
    }
    client.on('error', error => {
      this.logger.warn(JSON.stringify({
        event: 'runtime_limit_redis_error',
        errorName: error.name,
      }));
    });
    return client;
  }

  private async connectedRedis(): Promise<Redis> {
    const client = this.redis;
    if (!client) throw new Error('Distributed runtime limit storage is unavailable.');
    if (client.status === 'wait') {
      if (!this.redisConnection) {
        const pending = client.connect();
        this.redisConnection = pending.finally(() => { this.redisConnection = null; });
      }
      await this.redisConnection;
    }
    if (client.status !== 'ready') {
      throw new Error('Distributed runtime limit storage is not connected.');
    }
    return client;
  }

  private handleStoreError(operation: string, error: unknown) {
    this.logger.error(JSON.stringify({
      event: 'runtime_limit_store_unavailable',
      operation,
      store: this.store,
      errorName: error instanceof Error ? error.name : 'unknown',
    }));
    // Fail closed whenever distributed storage was explicitly requested.
    // A server-local fallback would allow cross-instance rate-limit/replay bypass.
    if (process.env.RUNTIME_LIMIT_ALLOW_LOCAL_FALLBACK !== 'true' ||
        process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException('Security checks temporarily unavailable.');
    }
  }

  async reserve(options: LimitOptions): Promise<LimitResult> {
    const safeLimit = Math.max(1, Math.floor(options.limit));
    const safeWindowMs = Math.max(1_000, Math.floor(options.windowMs));
    const normalizedOptions = {
      ...options,
      collection: options.collection || 'runtime_rate_limits',
      limit: safeLimit,
      windowMs: safeWindowMs,
    };

    if (this.store === 'memory') return this.reserveLocal(normalizedOptions);
    try {
      return this.store === 'redis'
        ? await this.reserveRedis(normalizedOptions)
        : await this.reserveFirestore(normalizedOptions);
    } catch (error) {
      this.handleStoreError('reserve', error);
      return this.reserveLocal(normalizedOptions);
    }
  }

  async assertNotReplay(key: string, ttlSeconds: number) {
    const safeTtlSeconds = Math.max(1, Math.floor(ttlSeconds));

    if (this.store === 'memory') return this.assertNotReplayLocal(key, safeTtlSeconds);
    try {
      return this.store === 'redis'
        ? await this.assertNotReplayRedis(key, safeTtlSeconds)
        : await this.assertNotReplayFirestore(key, safeTtlSeconds);
    } catch (error) {
      this.handleStoreError('replay', error);
      return this.assertNotReplayLocal(key, safeTtlSeconds);
    }
  }

  // Atomic fixed-window counter. One Redis round trip, bounded storage lifetime,
  // and no per-request Firestore transaction or hot-spot document.
  private async reserveRedis(options: Required<LimitOptions>): Promise<LimitResult> {
    const client = await this.connectedRedis();
    const key = `chefu:limits:${options.collection}:${this.keyHash(options.key)}`;
    const result = await client.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]); end; return {n,redis.call('PTTL',KEYS[1])}",
      1, key, String(options.windowMs),
    );
    if (!Array.isArray(result) || result.length !== 2) {
      throw new Error('Unexpected distributed limit response.');
    }
    const count = Number(result[0]);
    const ttlMs = Number(result[1]);
    if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new Error('Invalid distributed limit response.');
    }
    const resetAt = Date.now() + ttlMs;
    return {
      limited: count > options.limit,
      remaining: Math.max(0, options.limit - count),
      resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
    };
  }

  private async assertNotReplayRedis(key: string, ttlSeconds: number): Promise<boolean> {
    const client = await this.connectedRedis();
    const result = await client.set(
      `chefu:replay:${this.keyHash(key)}`,
      '1', 'EX', ttlSeconds, 'NX',
    );
    return result === 'OK';
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
