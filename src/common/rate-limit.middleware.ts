import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { auditRequestContext } from './security-audit';

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly logger = new Logger(RateLimitMiddleware.name);
  private readonly limit = Number(process.env.API_RATE_LIMIT_PER_MINUTE || 300);
  private readonly windowMs = Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60_000);

  use(request: Request, response: Response, next: NextFunction) {
    if (request.method === 'OPTIONS' || request.path === '/health') {
      next();
      return;
    }

    const now = Date.now();
    const key = `${request.ip}:${request.method}:${request.path}`;
    const current = this.buckets.get(key);
    const bucket =
      current && current.resetAt > now
        ? current
        : { count: 0, resetAt: now + this.windowMs };

    bucket.count += 1;
    this.buckets.set(key, bucket);

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((bucket.resetAt - now) / 1000),
    );
    const remaining = Math.max(0, this.limit - bucket.count);

    response.setHeader('RateLimit-Limit', String(this.limit));
    response.setHeader('RateLimit-Remaining', String(remaining));
    response.setHeader('RateLimit-Reset', String(retryAfterSeconds));

    if (bucket.count <= this.limit) {
      next();
      return;
    }

    response.setHeader('Retry-After', String(retryAfterSeconds));
    const auditContext = auditRequestContext(request);
    this.logger.warn(
      JSON.stringify({
        event: 'rate_limit_denied',
        method: request.method,
        path: auditContext.path,
        ipHash: auditContext.ipHash,
        retryAfterSeconds,
      }),
    );

    response.status(429).json({
      error: 'Too many requests. Please wait a moment and try again.',
    });
  }
}
