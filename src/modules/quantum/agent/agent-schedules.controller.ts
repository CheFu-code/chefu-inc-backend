import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../../auth/auth.guard';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { QuantumAgentSchedulesService } from './agent-schedules.service';
type UserRequest = Request & { user: AuthenticatedUser };

@Controller('quantum/agent/schedules')
@UseGuards(AuthGuard)
export class QuantumAgentSchedulesController {
  constructor(@Inject(QuantumAgentSchedulesService) private readonly schedules: QuantumAgentSchedulesService) {}
  @Get() list(@Req() req: UserRequest) { return this.schedules.list(req.user); }
  @Post() create(@Req() req: UserRequest, @Body() body: Parameters<QuantumAgentSchedulesService['create']>[1]) { return this.schedules.create(req.user, body); }
  @Patch(':id') update(@Req() req: UserRequest, @Param('id') id: string, @Body() body: { status?: unknown }) { return this.schedules.setStatus(req.user, id, body.status); }
  @Post(':id/run') run(@Req() req: UserRequest, @Param('id') id: string) { return this.schedules.run(id, req.user); }
}
