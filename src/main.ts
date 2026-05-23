import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { GlobalExceptionFilter } from './common/global-exception.filter';
import { NextFunction, Request, Response } from 'express';

function getAllowedOrigins() {
  const configuredOrigins =
    process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN;
  const defaults = [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://chefuinc.com',
    'https://academy.chefuinc.com',
  ];
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
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const allowedOrigins = getAllowedOrigins();

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
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-flow-api-key',
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
        'Content-Type,Authorization,x-flow-api-key,x-flow-webhook-secret',
      );
      response.setHeader(
        'Access-Control-Allow-Methods',
        'GET,POST,PATCH,DELETE,OPTIONS',
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
