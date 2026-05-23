import { Module } from '@nestjs/common';
import { FirebaseAdminModule } from '../firebase-admin/firebase-admin.module';
import { FlowController } from './flow.controller';
import { FlowService } from './flow.service';

@Module({
  imports: [FirebaseAdminModule],
  controllers: [FlowController],
  providers: [FlowService],
})
export class FlowModule {}
