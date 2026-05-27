import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FirebaseAdminModule } from '../firebase-admin/firebase-admin.module';
import { QuantumController } from './quantum.controller';
import { QuantumService } from './quantum.service';

@Module({
  imports: [AuthModule, FirebaseAdminModule],
  controllers: [QuantumController],
  providers: [QuantumService],
})
export class QuantumModule {}
