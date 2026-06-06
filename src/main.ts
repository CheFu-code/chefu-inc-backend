import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { validateProductionEnv } from './common/env';
import { GlobalExceptionFilter } from './common/global-exception.filter';
import { NextFunction, Request, Response } from 'express';
import {
  CHEFU_APP_HEADER,
  registeredAppOrigins,
} from './modules/apps/app-registry';

function getAllowedOrigins() {
  const configuredOrigins =
    process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN;
  const defaults = registeredAppOrigins();
  const origins = configuredOrigins
    ? [...defaults, ...configuredOrigins.split(',')]
    : defaults;

  return [
    ...new Set(
      origins
        .map(origin => normalizeOrigin(origin.trim()))
        .filter((origin): origin is string => Boolean(origin)),
    ),
  ];
}

function normalizeOrigin(origin: string) {
  if (!origin) return null;

  try {
    const url = new URL(origin);
    if (!isAllowedWebOrigin(url)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isAllowedOrigin(origin: string | undefined, allowedOrigins: string[]) {
  if (!origin) return true;

  try {
    return allowedOrigins.includes(new URL(origin).origin);
  } catch {
    return false;
  }
}

function isAllowedWebOrigin(url: URL) {
  if (url.protocol === 'https:') return true;

  return (
    process.env.NODE_ENV !== 'production' &&
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1'].includes(url.hostname)
  );
}

function shouldRejectInsecureRequest(request: Request) {
  if (
    process.env.NODE_ENV !== 'production' ||
    process.env.ENFORCE_HTTPS === 'false'
  ) {
    return false;
  }

  const forwardedProto = String(request.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();

  return !request.secure && forwardedProto !== 'https';
}

function setSecurityHeaders(response: Response) {
  response.setHeader(
    'Content-Security-Policy',
    "base-uri 'self'; frame-ancestors 'self'; object-src 'none'; upgrade-insecure-requests",
  );
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );
  if (process.env.NODE_ENV === 'production') {
    response.setHeader(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload',
    );
  }
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const envValidation = validateProductionEnv();

  const envProblems = [
    ...envValidation.missing.map(name => `missing ${name}`),
    ...envValidation.invalid.map(name => `invalid ${name}`),
  ];

  if (envProblems.length > 0) {
    throw new Error(
      `Production environment is not secure: ${envProblems.join(', ')}`,
    );
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  const allowedOrigins = getAllowedOrigins();
  const allowedHeaders = [
    'Content-Type',
    'Authorization',
    'DPoP',
    CHEFU_APP_HEADER,
    'x-api-key',
    'x-flow-api-key',
    'x-flow-session',
    'x-flow-webhook-secret',
    'x-request-id',
  ];

  app.set('trust proxy', 1);
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      frameguard: { action: 'sameorigin' },
      hsts:
        process.env.NODE_ENV === 'production'
          ? { includeSubDomains: true, maxAge: 63072000, preload: true }
          : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (shouldRejectInsecureRequest(request)) {
      response.status(400).json({
        error: 'HTTPS is required.',
      });
      return;
    }

    next();
  });

  app.useBodyParser('json', { limit: '8mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '8mb' });

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
    allowedHeaders,
    maxAge: 600,
    optionsSuccessStatus: 204,
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    setSecurityHeaders(response);

    const origin = request.headers.origin;

    if (isAllowedOrigin(origin, allowedOrigins) && origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader(
        'Access-Control-Allow-Headers',
        allowedHeaders.join(','),
      );
      response.setHeader(
        'Access-Control-Allow-Methods',
        'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      );
      response.setHeader('Vary', 'Origin');
    }

    next();
  });
  app.use(cookieParser());
  app.useGlobalFilters(new GlobalExceptionFilter());

  const port = Number(process.env.PORT || 4000);
  await app.listen(port);
  logger.log(
    JSON.stringify({
      event: 'api_started',
      port,
      nodeEnv: process.env.NODE_ENV || 'development',
      allowedOrigins,
      authCookieDomain: process.env.AUTH_COOKIE_DOMAIN || null,
    }),
  );
}

void bootstrap();
