import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FirebaseAdminModule } from '../firebase-admin/firebase-admin.module';
import { QuantumController } from './quantum.controller';
import { QuantumService } from './quantum.service';
import { QuantumAgentDataService } from './agent/agent-data.service';
import { QuantumAgentDataController } from './agent/agent-data.controller';
import { QuantumAgentToolsService } from './agent/agent-tools.service';
import { QuantumAgentToolsController } from './agent/agent-tools.controller';
import { QuantumAgentSchedulesService } from './agent/agent-schedules.service';
import { QuantumAgentSchedulesController } from './agent/agent-schedules.controller';

@Module({
  imports: [AuthModule, FirebaseAdminModule],
  controllers: [QuantumController, QuantumAgentDataController, QuantumAgentToolsController, QuantumAgentSchedulesController],
  providers: [QuantumService, QuantumAgentDataService, QuantumAgentToolsService, QuantumAgentSchedulesService],
})
export class QuantumModule {}
