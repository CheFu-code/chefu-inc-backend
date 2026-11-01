import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Response } from 'express';
import { RequestWithId } from './request-context';
import { auditRequestContext } from './security-audit';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestLoggerMiddleware.name);
  // Optional cost control: always log errors and slow requests. Security
  // events continue to have separate, unsampled audit logs.
  private readonly successSampleRate = (() => {
    const configured = Number(process.env.HTTP_SUCCESS_LOG_SAMPLE_RATE ?? 1);
    return Number.isFinite(configured) ? Math.min(1, Math.max(0, configured)) : 1;
  })();

  use(request: RequestWithId, response: Response, next: NextFunction) {
    const incomingId = request.headers['x-request-id'];
    const requestId = typeof incomingId === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(incomingId)
      ? incomingId : randomUUID();
    const startedAt = Date.now();

    request.requestId = requestId;
    response.setHeader('x-request-id', requestId);

    response.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      if (response.statusCode < 400 && durationMs < 2000 &&
          Math.random() >= this.successSampleRate) return;
      const auditContext = auditRequestContext(request);

      this.logger.log(
        JSON.stringify({
          event: 'http_request',
          requestId,
          method: request.method,
          path: auditContext.path,
          statusCode: response.statusCode,
          durationMs,
          origin: auditContext.origin,
          ipHash: auditContext.ipHash,
          userAgentHash: auditContext.userAgentHash,
        }),
      );
    });

    next();
  }
}
