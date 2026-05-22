import {
  Body,
  Controller,
  Headers,
  InternalServerErrorException,
  Logger,
  Post,
  Res,
} from '@nestjs/common';
import { Response } from 'express';

@Controller('email')
export class EmailController {
  private readonly logger = new Logger(EmailController.name);

  @Post('password-changed')
  async passwordChanged(
    @Body() body: unknown,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const endpoint = this.resolvePasswordChangedEmailUrl();

    if (!endpoint) {
      throw new InternalServerErrorException(
        'Password changed email endpoint is not configured.',
      );
    }

    this.logger.log(
      JSON.stringify({
        event: 'password_changed_email_started',
        hasAuthorization: Boolean(authorization),
      }),
    );

    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(body || {}),
    });

    response.status(upstream.status);
    const contentType = upstream.headers.get('content-type') || '';

    this.logger.log(
      JSON.stringify({
        event: 'password_changed_email_finished',
        statusCode: upstream.status,
        contentType,
      }),
    );

    if (contentType.includes('application/json')) {
      return upstream.json().catch(() => ({}));
    }

    return {
      ok: upstream.ok,
      message: await upstream.text().catch(() => ''),
    };
  }

  private resolvePasswordChangedEmailUrl() {
    const explicitUrl = process.env.PASSWORD_CHANGED_API_URL;
    if (explicitUrl) return explicitUrl.replace(/\/+$/, '');

    const projectId =
      process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;

    if (!projectId) return '';

    return `https://us-central1-${projectId}.cloudfunctions.net/sendPasswordChangedEmail`;
  }
}
