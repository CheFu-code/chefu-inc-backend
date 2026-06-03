import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { auditRequestContext, getClientIp } from './security-audit';
import { RuntimeLimitService } from './runtime-limit.service';

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RateLimitMiddleware.name);
  private readonly limit = Number(process.env.API_RATE_LIMIT_PER_MINUTE || 300);
  private readonly windowMs = Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60_000);

  constructor(private readonly runtimeLimits: RuntimeLimitService) {}

  async use(request: Request, response: Response, next: NextFunction) {
    if (request.method === 'OPTIONS' || request.path === '/health') {
      next();
      return;
    }

    const result = await this.runtimeLimits.reserve({
      collection: 'runtime_api_rate_limits',
      key: `${getClientIp(request) || 'unknown'}:${request.method}:${request.path}`,
      limit: this.limit,
      windowMs: this.windowMs,
    });

    response.setHeader('RateLimit-Limit', String(this.limit));
    response.setHeader('RateLimit-Remaining', String(result.remaining));
    response.setHeader('RateLimit-Reset', String(result.retryAfterSeconds));

    if (!result.limited) {
      next();
      return;
    }

    response.setHeader('Retry-After', String(result.retryAfterSeconds));
    const auditContext = auditRequestContext(request);
    this.logger.warn(
      JSON.stringify({
        event: 'rate_limit_denied',
        method: request.method,
        path: auditContext.path,
        ipHash: auditContext.ipHash,
        retryAfterSeconds: result.retryAfterSeconds,
      }),
    );

    response.status(429).json({
      error: 'Too many requests. Please wait a moment and try again.',
    });
  }
}
