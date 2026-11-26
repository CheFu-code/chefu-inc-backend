import { NextFunction, Request, Response } from 'express';
import { ForbiddenException } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { CHEFU_APP_HEADER } from '../modules/apps/app-registry';
import { SESSION_COOKIE_NAME } from '../modules/auth/session.constants';
import { isAllowedCookieMutationOrigin } from './csrf-protection';
import { CHECKOUT_COOKIE } from '../modules/store/checkout.validation';

export function normalizeOrigin(origin: string) {
  if (!origin) return null;

  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

export function isAllowedOrigin(origin: string | undefined, allowedOrigins: string[]) {
  if (!origin) return true;

  try {
    return allowedOrigins.includes(new URL(origin).origin);
  } catch {
    return false;
  }
}

export function configureCors(
  app: NestExpressApplication,
  allowedOrigins: string[],
  dynamicOrigin?: (origin: string) => Promise<boolean>,
) {
  app.enableCors({
    origin(
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) {
      if (isAllowedOrigin(origin, allowedOrigins)) {
        callback(null, true);
        return;
      }

      if (origin && dynamicOrigin) {
        void dynamicOrigin(origin).then(
          allowed => callback(allowed ? null : new ForbiddenException('Origin is not allowed by CORS.'), allowed),
          error => callback(error),
        );
      } else callback(new ForbiddenException('Origin is not allowed by CORS.'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'If-None-Match',
      'Idempotency-Key',
      CHEFU_APP_HEADER,
      'x-api-key',
    ],
  });
}

export function createSecurityHeadersMiddleware() {
  return (_request: Request, response: Response, next: NextFunction) => {
    response.setHeader(
      'Content-Security-Policy',
      "base-uri 'self'; frame-ancestors 'self'; object-src 'none'; upgrade-insecure-requests",
    );
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    );
    response.setHeader(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload',
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  };
}

export function createCookieCsrfMiddleware(allowedOrigins: string[], dynamicOrigin?: (origin: string) => Promise<boolean>) {
  return (request: Request, response: Response, next: NextFunction) => {
    const isStateChangingMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
      request.method,
    );
    const hasSessionCookie = Boolean(request.cookies?.[SESSION_COOKIE_NAME]);
    const normalizedPath = request.path.toLowerCase().replace(/\/+$/, '');
    const isCheckoutMutation = normalizedPath.startsWith('/store/checkout/') && normalizedPath !== '/store/checkout/webhook';
    if (
      isStateChangingMethod &&
      (hasSessionCookie || Boolean(request.cookies?.[CHECKOUT_COOKIE]) || isCheckoutMutation) &&
      !isAllowedCookieMutationOrigin(
        request.headers.origin,
        request.headers.referer,
        allowedOrigins,
      )
    ) {
      if (dynamicOrigin) {
        let candidate: string | undefined;
        try {
          const raw = request.headers.origin || (request.headers.referer ? new URL(request.headers.referer).origin : undefined);
          if (raw && new URL(raw).origin === raw) candidate = raw;
        } catch { /* Fail closed for malformed Origin/Referer. */ }
        if (candidate) {
          void dynamicOrigin(candidate).then(allowed => {
            if (allowed) next();
            else response.status(403).json({ message: 'A trusted Origin or Referer is required.' });
          }).catch(() => response.status(503).json({ message: 'Application registry is unavailable.' }));
          return;
        }
      }
      response.status(403).json({
        statusCode: 403,
        message: 'A trusted Origin or Referer is required for this request.',
      });
      return;
    }

    next();
  };
}
