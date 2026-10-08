import { Body, Controller, Delete, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthGuard } from '../auth/auth.guard';
import { NookMessagingService } from './nook-messaging.service';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller('nook/messages')
@UseGuards(AuthGuard)
export class NookMessagingController {
  constructor(private readonly messaging: NookMessagingService) {}

  @Post('push-token')
  registerPushToken(
    @Req() request: AuthenticatedRequest,
    @Body() body: { token?: string; platform?: 'ios' | 'android' },
  ) {
    return this.messaging.registerPushToken(request.user, body);
  }

  @Delete('push-token')
  removePushToken(@Req() request: AuthenticatedRequest, @Body() body: { token?: string }) {
    return this.messaging.removePushToken(request.user, body);
  }

  @Post(':conversationId/messages')
  send(
    @Req() request: AuthenticatedRequest,
    @Param('conversationId') conversationId: string,
    @Body() body: { text?: string; requestId?: string; replyToId?: string },
  ) {
    return this.messaging.send(request.user, conversationId, body);
  }
}