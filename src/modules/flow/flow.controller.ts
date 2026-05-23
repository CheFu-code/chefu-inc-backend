import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
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

  @Post('send')
  send(
    @Body() body: FlowSendPayload,
    @Headers('x-flow-api-key') flowApiKey?: string,
  ) {
    this.assertFlowApiKey(flowApiKey);
    return this.flowService.send(body);
  }

  private assertFlowApiKey(flowApiKey?: string) {
    const requiredKey = process.env.FLOW_API_KEY;
    if (!requiredKey) return;

    if (flowApiKey !== requiredKey) {
      throw new ForbiddenException('Invalid Flow API key.');
    }
  }
}

