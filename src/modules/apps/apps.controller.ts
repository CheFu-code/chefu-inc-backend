import { Body, Controller, Get, Header, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AppsService } from './apps.service';
import { AuthGuard } from '../auth/auth.guard';
import { UserManagementGuard, AdminRequest } from '../user-management/user-management.guard';
import type { RegistrationInput } from './app-validation';

@Controller('admin/apps')
@UseGuards(AuthGuard, UserManagementGuard)
export class AppsController {
  constructor(private readonly apps: AppsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  async list() { return { staticApps: this.apps.list(), dynamicApps: await this.apps.listRegisteredApps() }; }

  @Post('register')
  @HttpCode(201)
  @Header('Cache-Control', 'private, no-store')
  register(@Body() body: RegistrationInput, @Req() request: AdminRequest) { return this.apps.registerOauthClient(body, request.user.email); }

  @Post(':clientId/approve')
  @Header('Cache-Control', 'private, no-store')
  approve(@Param('clientId') id: string, @Req() request: AdminRequest) { return this.apps.approveOauthClient(id, request.user.email); }

  @Post(':clientId/revoke')
  @Header('Cache-Control', 'private, no-store')
  revoke(@Param('clientId') id: string, @Req() request: AdminRequest) { return this.apps.revokeOauthClient(id, request.user.email); }

  @Post(':clientId/rotate-secret')
  @Header('Cache-Control', 'private, no-store')
  rotate(@Param('clientId') id: string) { return this.apps.rotateClientSecret(id); }
}
