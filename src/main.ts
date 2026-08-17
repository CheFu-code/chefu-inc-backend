import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
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
    return new URL(origin).origin;
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
  response.setHeader(
    'Strict-Transport-Security',
    'max-age=63072000; includeSubDomains; preload',
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const envValidation = validateProductionEnv();

  if (envValidation.missing.length > 0) {
    throw new Error(
      `Missing required production environment variables: ${envValidation.missing.join(', ')}`,
    );
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  const allowedOrigins = getAllowedOrigins();

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
  app.use((request: Request, response: Response, next: NextFunction) => {
    setSecurityHeaders(response);

    const origin = request.headers.origin;

    if (isAllowedOrigin(origin, allowedOrigins) && origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Credentials', 'true');
      response.setHeader(
        'Access-Control-Allow-Headers',
        `Content-Type,Authorization,${CHEFU_APP_HEADER},x-api-key,x-flow-api-key,x-flow-session,x-flow-webhook-secret`,
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
  await app.listen(port, '0.0.0.0');
  logger.log(
    JSON.stringify({
      event: 'api_started',
      port,
      host: '0.0.0.0',
      nodeEnv: process.env.NODE_ENV || 'development',
      allowedOrigins,
      authCookieDomain: process.env.AUTH_COOKIE_DOMAIN || null,
    }),
  );
}

void bootstrap();
