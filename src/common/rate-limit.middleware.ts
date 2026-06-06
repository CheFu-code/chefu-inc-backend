import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { createHash } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { auditRequestContext, getClientIp, hashForAudit } from './security-audit';
import { RuntimeLimitService } from './runtime-limit.service';

type SensitiveRateLimitPolicy = {
  identifier?: (request: Request) => string | null;
  identifierLimit?: number;
  ipLimit: number;
  name: string;
  path: RegExp;
  windowMs: number;
};

const MINUTE = 60_000;
const SENSITIVE_POLICIES: SensitiveRateLimitPolicy[] = [
  {
    identifier: request => fieldValue(request, 'client_id'),
    identifierLimit: numberEnv('OAUTH_AUTHORIZE_CLIENT_RATE_LIMIT_PER_MINUTE', 80),
    ipLimit: numberEnv('OAUTH_AUTHORIZE_IP_RATE_LIMIT_PER_MINUTE', 30),
    name: 'oauth_authorize',
    path: /^\/oauth\/authorize$/,
    windowMs: MINUTE,
  },
  {
    identifier: request =>
      [
        fieldValue(request, 'client_id') || 'unknown-client',
        fieldValue(request, 'grant_type') || 'unknown-grant',
      ].join(':'),
    identifierLimit: numberEnv('OAUTH_TOKEN_CLIENT_RATE_LIMIT_PER_MINUTE', 40),
    ipLimit: numberEnv('OAUTH_TOKEN_IP_RATE_LIMIT_PER_MINUTE', 20),
    name: 'oauth_token',
    path: /^\/oauth\/token$/,
    windowMs: MINUTE,
  },
  {
    identifier: request => fieldValue(request, 'client_id'),
    identifierLimit: numberEnv('OAUTH_REVOKE_CLIENT_RATE_LIMIT_PER_MINUTE', 60),
    ipLimit: numberEnv('OAUTH_REVOKE_IP_RATE_LIMIT_PER_MINUTE', 30),
    name: 'oauth_revoke',
    path: /^\/oauth\/revoke$/,
    windowMs: MINUTE,
  },
  {
    identifier: bearerIdentifier,
    identifierLimit: numberEnv('OAUTH_USERINFO_TOKEN_RATE_LIMIT_PER_MINUTE', 90),
    ipLimit: numberEnv('OAUTH_USERINFO_IP_RATE_LIMIT_PER_MINUTE', 60),
    name: 'oauth_userinfo',
    path: /^\/oauth\/userinfo$/,
    windowMs: MINUTE,
  },
  {
    identifier: bearerIdentifier,
    identifierLimit: numberEnv('AUTH_SESSION_TOKEN_RATE_LIMIT_PER_MINUTE', 20),
    ipLimit: numberEnv('AUTH_SESSION_IP_RATE_LIMIT_PER_MINUTE', 12),
    name: 'auth_session',
    path: /^\/auth\/(session|mfa\/backup-code\/session|send-otp)$/,
    windowMs: MINUTE,
  },
  {
    identifier: bearerIdentifier,
    identifierLimit: numberEnv('QUANTUM_SYNC_TOKEN_RATE_LIMIT_PER_MINUTE', 120),
    ipLimit: numberEnv('QUANTUM_SYNC_IP_RATE_LIMIT_PER_MINUTE', 80),
    name: 'quantum_sync',
    path: /^\/quantum\/conversations(?:\/[^/]+)?$/,
    windowMs: MINUTE,
  },
];

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

    const result = await this.reserveGeneralLimit(request, response);

    if (result.limited) {
      this.deny(request, response, 'rate_limit_denied', result.retryAfterSeconds);
      return;
    }

    const sensitivePolicy = SENSITIVE_POLICIES.find(policy =>
      policy.path.test(request.path),
    );

    if (sensitivePolicy) {
      const sensitiveResult = await this.reserveSensitiveLimit(
        request,
        sensitivePolicy,
      );

      if (sensitiveResult.limited) {
        this.deny(
          request,
          response,
          'sensitive_rate_limit_denied',
          sensitiveResult.retryAfterSeconds,
          {
            identifierHash: hashForAudit(sensitiveResult.identifier),
            policy: sensitivePolicy.name,
            scope: sensitiveResult.scope,
          },
        );
        return;
      }
    }

    next();
  }

  private async reserveGeneralLimit(request: Request, response: Response) {
    const result = await this.runtimeLimits.reserve({
      collection: 'runtime_api_rate_limits',
      key: `${getClientIp(request) || 'unknown'}:${request.method}:${request.path}`,
      limit: this.limit,
      windowMs: this.windowMs,
    });

    response.setHeader('RateLimit-Limit', String(this.limit));
    response.setHeader('RateLimit-Remaining', String(result.remaining));
    response.setHeader('RateLimit-Reset', String(result.retryAfterSeconds));

    return result;
  }

  private async reserveSensitiveLimit(
    request: Request,
    policy: SensitiveRateLimitPolicy,
  ) {
    const ip = getClientIp(request) || 'unknown';
    const ipResult = await this.runtimeLimits.reserve({
      collection: 'runtime_sensitive_rate_limits',
      key: `ip:${policy.name}:${ip}:${request.method}`,
      limit: policy.ipLimit,
      windowMs: policy.windowMs,
    });

    if (ipResult.limited) {
      return {
        ...ipResult,
        identifier: ip,
        scope: 'ip',
      };
    }

    const identifier = policy.identifier?.(request);
    if (!identifier || !policy.identifierLimit) {
      return {
        ...ipResult,
        identifier: null,
        scope: 'ip',
      };
    }

    const identifierResult = await this.runtimeLimits.reserve({
      collection: 'runtime_sensitive_rate_limits',
      key: `id:${policy.name}:${stableHash(identifier)}:${request.method}`,
      limit: policy.identifierLimit,
      windowMs: policy.windowMs,
    });

    return {
      ...identifierResult,
      identifier,
      scope: 'identifier',
    };
  }

  private deny(
    request: Request,
    response: Response,
    event: string,
    retryAfterSeconds: number,
    extra?: Record<string, unknown>,
  ) {
    response.setHeader('Retry-After', String(retryAfterSeconds));
    const auditContext = auditRequestContext(request);
    this.logger.warn(
      JSON.stringify({
        event,
        method: request.method,
        path: auditContext.path,
        ipHash: auditContext.ipHash,
        retryAfterSeconds,
        ...(extra || {}),
      }),
    );

    response.status(429).json({
      error: 'Too many requests. Please wait a moment and try again.',
    });
  }
}

function numberEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
}

function fieldValue(request: Request, name: string) {
  const source = {
    ...(isRecord(request.query) ? request.query : {}),
    ...(isRecord(request.body) ? request.body : {}),
  };
  const value = source[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bearerIdentifier(request: Request) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return null;

  return `bearer:${stableHash(authorization.slice('Bearer '.length).trim())}`;
}

function stableHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
