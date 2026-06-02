import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FirebaseAdminModule } from '../firebase-admin/firebase-admin.module';
import { FlowController } from './flow.controller';
import { FlowAccessKeyService } from './flow-access-key.service';
import { FlowService } from './flow.service';

@Module({
  imports: [AuthModule, FirebaseAdminModule],
  controllers: [FlowController],
  providers: [FlowAccessKeyService, FlowService],
})
export class FlowModule {}
