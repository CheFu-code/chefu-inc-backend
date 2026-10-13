import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../../auth/auth.guard';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { QuantumAgentToolsService } from './agent-tools.service';
type UserRequest = Request & { user: AuthenticatedUser };

@Controller('quantum/agent/tools')
@UseGuards(AuthGuard)
export class QuantumAgentToolsController {
  constructor(@Inject(QuantumAgentToolsService) private readonly tools: QuantumAgentToolsService) {}
  @Get() list(@Req() req: UserRequest) { return this.tools.list(req.user.uid); }
  @Post(':id/connect') connect(@Req() req: UserRequest, @Param('id') id: string, @Body() body: { callbackUrl?: unknown }) { return this.tools.connect(req.user.uid, id, body.callbackUrl); }
  @Get(':id/status') status(@Req() req: UserRequest, @Param('id') id: string) { return this.tools.status(req.user.uid, id); }
  @Post(':id/disconnect') disconnect(@Req() req: UserRequest, @Param('id') id: string) { return this.tools.disconnect(req.user.uid, id); }
}
