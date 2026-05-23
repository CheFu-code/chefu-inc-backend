import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Query,
  Post,
} from '@nestjs/common';
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
    @Headers('x-flow-api-key') flowApiKey?: string,
    @Headers('x-flow-webhook-secret') webhookSecret?: string,
  ) {
    this.assertInboundSecret(flowApiKey, webhookSecret);
    return this.flowService.receiveInbound(body);
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
}
