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
import { auditRequestContext, redactSensitiveText } from './security-audit';

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

    const safeMessage = this.safeMessage(message);
    const clientMessage =
      status >= HttpStatus.INTERNAL_SERVER_ERROR
        ? 'Internal server error'
        : safeMessage;

    const logPayload = JSON.stringify({
      event: 'request_error',
      requestId: getRequestId(request),
      method: request.method,
      path: auditRequestContext(request).path,
      statusCode: status,
      message: safeMessage,
    });

    if (status >= 500) {
      this.logger.error(
        logPayload,
        process.env.NODE_ENV === 'production'
          ? undefined
          : exception instanceof Error
            ? exception.stack
            : undefined,
      );
    } else {
      this.logger.warn(logPayload);
    }

    response.status(status).json({
      error: clientMessage,
      requestId: getRequestId(request),
    });
  }

  private safeMessage(value: unknown) {
    const redacted = redactSensitiveText(value).trim();
    return redacted || 'Request failed';
  }
}
