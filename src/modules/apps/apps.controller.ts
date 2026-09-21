import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { AppsService } from './apps.service';

@Controller('admin/apps')
export class AppsController {
  constructor(private readonly appsService: AppsService) {}

  @Get()
  listApps(@Query('include') include?: string) {
    if (include === 'dynamic') {
      return this.appsService.listRegisteredApps();
    }

    return {
      staticApps: this.appsService.list(),
      dynamicApps: this.appsService.listRegisteredApps(),
    };
  }

  @Post('register')
  @HttpCode(201)
  async registerApp(
    @Body()
    body: {
      appId: string;
      clientId?: string;
      name: string;
      owner: string;
      redirectUris: string[];
      allowedScopes: string[];
      grantTypes?: string[];
      clientType?: 'public' | 'confidential';
      status?: 'pending' | 'approved' | 'revoked';
    },
  ) {
    return this.appsService.registerOauthClient(body);
  }

  @Post(':clientId/approve')
  async approveApp(
    @Param('clientId') clientId: string,
    @Body() body: { approvedBy: string },
  ) {
    return this.appsService.approveOauthClient(clientId, body.approvedBy);
  }

  @Post(':clientId/revoke')
  async revokeApp(
    @Param('clientId') clientId: string,
    @Body() body: { approvedBy: string },
  ) {
    return this.appsService.revokeOauthClient(clientId, body.approvedBy);
  }
}
