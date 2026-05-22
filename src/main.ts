import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { GlobalExceptionFilter } from './common/global-exception.filter';

function getAllowedOrigins() {
  const configuredOrigins =
    process.env.FRONTEND_ORIGINS || process.env.FRONTEND_ORIGIN;
  const defaults = [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://chefuinc.com',
    'https://academy.chefuinc.com',
  ];

  return (configuredOrigins ? configuredOrigins.split(',') : defaults)
    .map(origin => origin.trim())
    .filter(Boolean);
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  const allowedOrigins = getAllowedOrigins();

  app.enableCors({
    origin(
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by CORS.`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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
