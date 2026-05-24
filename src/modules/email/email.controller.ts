import {
  Body,
  Controller,
  Headers,
  Inject,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthGuard } from '../auth/auth.guard';
import { ResendService } from './resend.service';

type RequestWithUser = Request & {
  user?: AuthenticatedUser;
};

@Controller('email')
export class EmailController {
  private readonly logger = new Logger(EmailController.name);

  constructor(
    @Inject(ResendService)
    private readonly resendService: ResendService,
  ) {}

  @Post('password-changed')
  @UseGuards(AuthGuard)
  async passwordChanged(
    @Body() body: { deviceInfo?: string; userName?: string } | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Req() request: RequestWithUser,
  ) {
    const email = request.user?.email;

    this.logger.log(
      JSON.stringify({
        event: 'password_changed_email_started',
        hasAuthorization: Boolean(authorization),
        email,
      }),
    );

    if (!email) {
      return {
        sent: false,
        reason: 'Authenticated user email was not available.',
      };
    }

    await this.resendService.sendPasswordChangedNotification({
      email,
      userName: body?.userName,
      deviceInfo: body?.deviceInfo || request.headers['user-agent'],
      ipAddress: this.getClientIp(request),
      timestamp: new Date(),
    });

    this.logger.log(
      JSON.stringify({
        event: 'password_changed_email_finished',
        sent: true,
        email,
      }),
    );

    return {
      sent: true,
    };
  }

  private getClientIp(request: Request) {
    const forwardedFor = request.headers['x-forwarded-for'];
    if (Array.isArray(forwardedFor)) return forwardedFor[0];
    if (forwardedFor) return forwardedFor.split(',')[0]?.trim();
    return request.ip;
  }
}
