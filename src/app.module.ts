import { Module } from '@nestjs/common';
import { AdminModule } from './modules/admin/admin.module';
import { AiModule } from './modules/ai/ai.module';
import { AuthModule } from './modules/auth/auth.module';
import { EmailModule } from './modules/email/email.module';
import { FirebaseAdminModule } from './modules/firebase-admin/firebase-admin.module';
import { HealthController } from './modules/health/health.controller';

@Module({
  imports: [
    FirebaseAdminModule,
    AuthModule,
    AiModule,
    AdminModule,
    EmailModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
