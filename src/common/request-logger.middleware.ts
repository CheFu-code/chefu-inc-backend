import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Response } from 'express';
import { RequestWithId } from './request-context';
import { auditRequestContext } from './security-audit';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestLoggerMiddleware.name);

  use(request: RequestWithId, response: Response, next: NextFunction) {
    const requestId = request.headers['x-request-id']?.toString() || randomUUID();
    const startedAt = Date.now();

    request.requestId = requestId;
    response.setHeader('x-request-id', requestId);

    response.on('finish', () => {
      const durationMs = Date.now() - startedAt;
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
