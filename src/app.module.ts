import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { RequestLoggerMiddleware } from './common/request-logger.middleware';
import { AdminModule } from './modules/admin/admin.module';
import { AiModule } from './modules/ai/ai.module';
import { AppsModule } from './modules/apps/apps.module';
import { AuthModule } from './modules/auth/auth.module';
import { BillingModule } from './modules/billing/billing.module';
import { CoursesModule } from './modules/courses/courses.module';
import { EmailModule } from './modules/email/email.module';
import { FirebaseAdminModule } from './modules/firebase-admin/firebase-admin.module';
import { FlowModule } from './modules/flow/flow.module';
import { HealthController } from './modules/health/health.controller';
import { KeepaliveModule } from './modules/keepalive/keepalive.module';
import { NotificationsModule } from './modules/notifications/notifications.module';

@Module({
  imports: [
    AppsModule,
    FirebaseAdminModule,
    AuthModule,
    AiModule,
    AdminModule,
    EmailModule,
    BillingModule,
    CoursesModule,
    NotificationsModule,
    FlowModule,
    KeepaliveModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestLoggerMiddleware).forRoutes('*');
  }
}
