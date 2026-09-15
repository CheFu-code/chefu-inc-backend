import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FirebaseAdminModule } from '../firebase-admin/firebase-admin.module';

import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

@Module({
  imports: [AuthModule, FirebaseAdminModule],
  controllers: [WhatsappController],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}