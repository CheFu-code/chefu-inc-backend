import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  UnauthorizedException,
  Req,
  Query,
  Param,
  Post,
} from '@nestjs/common';
import { Request } from 'express';
import { Webhook } from 'svix';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { SESSION_COOKIE_NAME } from '../auth/session.constants';
import {
  FLOW_ACCESS_DENIED_MESSAGE,
  isFlowAllowedEmail,
} from './flow-access';
import { FlowSendPayload } from './flow-email.types';
import { FlowService } from './flow.service';

@Controller('flow')
export class FlowController {
  constructor(
    @Inject(FlowService)
    private readonly flowService: FlowService,
    @Inject(FirebaseAdminService)
    private readonly firebaseAdmin: FirebaseAdminService,
  ) {}

  @Get('config')
  getConfig() {
    return this.flowService.getConfig();
  }

  @Get('messages')
  async messages(
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
    @Query('folder') folder?: string,
  ) {
    await this.assertFlowAccess(flowApiKey, request);
    return this.flowService.getMessages(folder);
  }

  @Get('messages/:messageId/attachments')
  async attachments(
    @Param('messageId') messageId: string,
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request);
    return this.flowService.listAttachments(messageId);
  }

  @Get('messages/:messageId/attachments/:attachmentId')
  async attachment(
    @Param('messageId') messageId: string,
    @Param('attachmentId') attachmentId: string,
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request);
    return this.flowService.getAttachment(messageId, attachmentId);
  }

  @Post('messages/:messageId/read')
  async markRead(
    @Param('messageId') messageId: string,
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request);
    return this.flowService.markRead(messageId);
  }

  @Post('send')
  async send(
    @Body() body: FlowSendPayload,
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Req() request?: Request,
  ) {
    await this.assertFlowAccess(flowApiKey, request);
    return this.flowService.send(body);
  }

  @Post('inbound')
  inbound(
    @Body() body: unknown,
    @Req() request: Request & { rawBody?: Buffer },
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Headers('x-flow-webhook-secret') webhookSecret?: string,
    @Headers('svix-id') svixId?: string,
    @Headers('svix-timestamp') svixTimestamp?: string,
    @Headers('svix-signature') svixSignature?: string,
  ) {
    const payload = this.verifyInboundPayload(body, request, {
      flowApiKey,
      svixId,
      svixSignature,
      svixTimestamp,
      webhookSecret,
    });

    return this.flowService.receiveInbound(payload);
  }

  private assertFlowApiKey(flowApiKey?: string) {
    const requiredKey = process.env.FLOW_API_KEY;
    if (!requiredKey) return;

    if (flowApiKey !== requiredKey) {
      throw new ForbiddenException('Invalid Flow API key.');
    }
  }

  private async assertFlowAccess(flowApiKey?: string, request?: Request) {
    const requiredKey = process.env.FLOW_API_KEY;
    const isBrowserRequest = Boolean(request?.headers.origin);

    if (!isBrowserRequest && (!requiredKey || flowApiKey === requiredKey)) {
      return;
    }

    const sessionCookie = request?.cookies?.[SESSION_COOKIE_NAME];

    if (!sessionCookie) {
      throw new UnauthorizedException('Authentication required.');
    }

    try {
      const decodedToken = await this.firebaseAdmin
        .auth()
        .verifySessionCookie(sessionCookie, true);

      if (!isFlowAllowedEmail(decodedToken.email)) {
        throw new ForbiddenException(FLOW_ACCESS_DENIED_MESSAGE);
      }
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      throw new UnauthorizedException('Authentication required.');
    }
  }

  private assertInboundSecret(flowApiKey?: string, webhookSecret?: string) {
    const requiredWebhookSecret = process.env.FLOW_INBOUND_SECRET;
    if (requiredWebhookSecret) {
      if (webhookSecret !== requiredWebhookSecret) {
        throw new ForbiddenException('Invalid Flow inbound secret.');
      }
      return;
    }

    this.assertFlowApiKey(flowApiKey);
  }

  private verifyInboundPayload(
    body: unknown,
    request: Request & { rawBody?: Buffer },
    headers: {
      flowApiKey?: string;
      svixId?: string;
      svixSignature?: string;
      svixTimestamp?: string;
      webhookSecret?: string;
    },
  ) {
    const resendWebhookSecret = process.env.RESEND_WEBHOOK_SECRET;

    if (!resendWebhookSecret) {
      this.assertInboundSecret(headers.flowApiKey, headers.webhookSecret);
      return body;
    }

    if (!headers.svixId || !headers.svixTimestamp || !headers.svixSignature) {
      throw new ForbiddenException('Missing Resend webhook signature headers.');
    }

    try {
      const rawBody = request.rawBody?.toString('utf8') || JSON.stringify(body);
      return new Webhook(resendWebhookSecret).verify(rawBody, {
        'svix-id': headers.svixId,
        'svix-signature': headers.svixSignature,
        'svix-timestamp': headers.svixTimestamp,
      });
    } catch {
      throw new ForbiddenException('Invalid Resend webhook signature.');
    }
  }
}
