import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { RequestLoggerMiddleware } from './common/request-logger.middleware';
import { AdminModule } from './modules/admin/admin.module';
import { AiModule } from './modules/ai/ai.module';
import { AuthModule } from './modules/auth/auth.module';
import { BillingModule } from './modules/billing/billing.module';
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
    BillingModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestLoggerMiddleware).forRoutes('*');
  }
}
