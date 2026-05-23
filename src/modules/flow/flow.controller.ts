import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Req,
  Query,
  Post,
} from '@nestjs/common';
import { Request } from 'express';
import { Webhook } from 'svix';
import { FlowSendPayload } from './flow-email.types';
import { FlowService } from './flow.service';

@Controller('flow')
export class FlowController {
  constructor(private readonly flowService: FlowService) {}

  @Get('config')
  getConfig() {
    return this.flowService.getConfig();
  }

  @Get('messages')
  messages(
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Query('folder') folder?: string,
  ) {
    this.assertFlowApiKey(flowApiKey);
    return this.flowService.getMessages(folder);
  }

  @Post('send')
  send(
    @Body() body: FlowSendPayload,
    @Headers('x-flow-api-key') flowApiKey?: string,
  ) {
    this.assertFlowApiKey(flowApiKey);
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
