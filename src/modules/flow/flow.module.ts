import { Module } from '@nestjs/common';
import { FirebaseAdminModule } from '../firebase-admin/firebase-admin.module';
import { FlowController } from './flow.controller';
import { FlowAccessKeyService } from './flow-access-key.service';
import { FlowService } from './flow.service';

@Module({
  imports: [FirebaseAdminModule],
  controllers: [FlowController],
  providers: [FlowAccessKeyService, FlowService],
})
export class FlowModule {}
