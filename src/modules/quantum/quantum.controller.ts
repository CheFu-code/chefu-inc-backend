import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthGuard } from '../auth/auth.guard';
import { QuantumService } from './quantum.service';
import {
  ReplaceQuantumConversationsPayload,
  UpsertQuantumConversationPayload,
} from './quantum.types';

type AuthenticatedRequest = Request & {
  user: AuthenticatedUser;
};

@Controller('quantum')
@UseGuards(AuthGuard)
export class QuantumController {
  constructor(
    @Inject(QuantumService)
    private readonly quantumService: QuantumService,
  ) {}

  @Get('conversations')
  conversations(@Req() request: AuthenticatedRequest) {
    return this.quantumService.listConversations(request.user);
  }

  @Put('conversations')
  replaceConversations(
    @Req() request: AuthenticatedRequest,
    @Body() body: ReplaceQuantumConversationsPayload,
  ) {
    return this.quantumService.replaceConversations(
      request.user,
      body.conversations,
    );
  }

  @Put('conversations/:conversationId')
  upsertConversation(
    @Req() request: AuthenticatedRequest,
    @Param('conversationId') conversationId: string,
    @Body() body: UpsertQuantumConversationPayload,
  ) {
    return this.quantumService.upsertConversation(
      request.user,
      body.conversation,
      conversationId,
    );
  }

  @Delete('conversations/:conversationId')
  deleteConversation(
    @Req() request: AuthenticatedRequest,
    @Param('conversationId') conversationId: string,
  ) {
    return this.quantumService.deleteConversation(request.user, conversationId);
  }
}
