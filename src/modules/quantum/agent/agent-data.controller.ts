import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../../auth/auth.guard';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { QuantumAgentDataService } from './agent-data.service';

type UserRequest = Request & { user: AuthenticatedUser };

@Controller('quantum/agent/threads')
@UseGuards(AuthGuard)
export class QuantumAgentDataController {
  constructor(@Inject(QuantumAgentDataService) private readonly data: QuantumAgentDataService) {}
  @Get() list(@Req() req: UserRequest) { return this.data.listThreads(req.user); }
  @Post() create(@Req() req: UserRequest, @Body() body: Parameters<QuantumAgentDataService['createThread']>[1]) { return this.data.createThread(req.user, body); }
  @Get(':id') get(@Req() req: UserRequest, @Param('id') id: string) { return this.data.getThread(req.user, id); }
  @Delete(':id') remove(@Req() req: UserRequest, @Param('id') id: string) { return this.data.deleteThread(req.user, id); }
  @Get(':id/messages') messages(@Req() req: UserRequest, @Param('id') id: string) { return this.data.listMessages(req.user, id); }
  @Post(':id/messages') save(@Req() req: UserRequest, @Param('id') id: string, @Body() body: Parameters<QuantumAgentDataService['saveMessage']>[2]) { return this.data.saveMessage(req.user, id, body); }
  @Patch(':id/messages/:messageId') update(@Req() req: UserRequest, @Param('id') id: string, @Param('messageId') messageId: string, @Body() body: Parameters<QuantumAgentDataService['updateMessage']>[3]) { return this.data.updateMessage(req.user, id, messageId, body); }
}
