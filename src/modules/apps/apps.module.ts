import { Module } from '@nestjs/common';
import { AppPolicyController } from './app-policy.controller';
import { AppsService } from './apps.service';

@Module({
  controllers: [AppPolicyController],
  providers: [AppsService],
  exports: [AppsService],
})
export class AppsModule {}
