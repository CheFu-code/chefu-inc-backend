import {
  Body,
  Controller,
  Get,
  Patch,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthGuard } from '../auth/auth.guard';
import { NotificationsService } from './notifications.service';

type NotificationRequest = Request & {
  user?: AuthenticatedUser;
};

@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get('preferences')
  getPreferences(@Req() request: NotificationRequest) {
    return this.notificationsService.getPreferences(this.requireUser(request));
  }

  @Patch('preferences')
  updatePreferences(
    @Req() request: NotificationRequest,
    @Body() body: unknown,
  ) {
    return this.notificationsService.updatePreferences(
      this.requireUser(request),
      body,
    );
  }

  private requireUser(request: NotificationRequest) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user missing from request.');
    }

    return request.user;
  }
}
