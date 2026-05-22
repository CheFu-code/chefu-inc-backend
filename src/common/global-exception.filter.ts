import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { getRequestId, RequestWithId } from './request-context';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<RequestWithId>();
    const response = context.getResponse<Response>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload =
      exception instanceof HttpException
        ? exception.getResponse()
        : 'Internal server error';
    const message =
      typeof payload === 'string'
        ? payload
        : typeof payload === 'object' && payload && 'message' in payload
          ? (payload as { message?: unknown }).message
          : 'Request failed';

    const logPayload = JSON.stringify({
      event: 'request_error',
      requestId: getRequestId(request),
      method: request.method,
      path: request.originalUrl,
      statusCode: status,
      message,
    });

    if (status >= 500) {
      this.logger.error(
        logPayload,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(logPayload);
    }

    response.status(status).json({
      error: message,
      requestId: getRequestId(request),
    });
  }
}
