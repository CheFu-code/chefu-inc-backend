import { Controller, Get, Header, NotFoundException, Param } from '@nestjs/common';
import { AppsService } from './apps.service';

@Controller('apps')
export class AppPolicyController {
  constructor(private readonly apps: AppsService) {}

  @Get('policy/:appId')
  @Header('Cache-Control', 'no-store')
  async policy(@Param('appId') appId: string) {
    const policy = await this.apps.policy(appId);
    if (!policy) throw new NotFoundException('Unknown or inactive application.');
    return policy;
  }
}
