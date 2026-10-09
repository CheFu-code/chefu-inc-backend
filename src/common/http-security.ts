import { NextFunction, Request, Response } from 'express';
import { NestExpressApplication } from '@nestjs/platform-express';
import { CHEFU_APP_HEADER } from '../modules/apps/app-registry';
import { SESSION_COOKIE_NAME } from '../modules/auth/session.constants';
import { isAllowedCookieMutationOrigin } from './csrf-protection';

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

      callback(new Error(`Origin ${origin} is not allowed by CORS.`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      CHEFU_APP_HEADER,
      'x-api-key',
      'x-flow-api-key',
      'x-flow-session',
      'x-flow-webhook-secret',
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

export function createCookieCsrfMiddleware(allowedOrigins: string[]) {
  return (request: Request, response: Response, next: NextFunction) => {
    const isStateChangingMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(
      request.method,
    );
    const hasSessionCookie = Boolean(request.cookies?.[SESSION_COOKIE_NAME]);
    if (
      isStateChangingMethod &&
      hasSessionCookie &&
      !isAllowedCookieMutationOrigin(
        request.headers.origin,
        request.headers.referer,
        allowedOrigins,
      )
    ) {
      response.status(403).json({
        statusCode: 403,
        message: 'A trusted Origin or Referer is required for this request.',
      });
      return;
    }

    next();
  };
}

export function captureFlowInboundRawBody(
  request: Request & { rawBody?: Buffer },
  _response: Response,
  body: Buffer,
) {
  if (request.path === '/flow/inbound') {
    request.rawBody = Buffer.from(body);
  }
}
