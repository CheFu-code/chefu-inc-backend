import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
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

  return [...new Set(origins.map(origin => origin.trim()).filter(Boolean))];
}

function isAllowedOrigin(origin: string | undefined, allowedOrigins: string[]) {
  if (!origin) return true;

  try {
    const { hostname, protocol } = new URL(origin);
    return (
      allowedOrigins.includes(origin) ||
      (protocol === 'https:' &&
        (hostname === 'chefuinc.com' || hostname.endsWith('.chefuinc.com'))) ||
      (protocol === 'http:' && hostname === 'localhost')
    );
  } catch {
    return false;
  }
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');
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
