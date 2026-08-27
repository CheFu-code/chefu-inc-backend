import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { RateLimitMiddleware } from './common/rate-limit.middleware';
import { RequestLoggerMiddleware } from './common/request-logger.middleware';
import { AcademySdkModule } from './modules/academy-sdk/academy-sdk.module';
import { AcademyMobileModule } from './modules/academy-mobile/academy-mobile.module';
import { AiModule } from './modules/ai/ai.module';
import { AppsModule } from './modules/apps/apps.module';
import { AuthModule } from './modules/auth/auth.module';
import { BillingModule } from './modules/billing/billing.module';
import { CoursesModule } from './modules/courses/courses.module';
import { EmailModule } from './modules/email/email.module';
import { FirebaseAdminModule } from './modules/firebase-admin/firebase-admin.module';
import { DrippybanksModule } from './modules/drippybanks/drippybanks.module';
import { FlowModule } from './modules/flow/flow.module';
import { InfinityModule } from './modules/infinity/infinity.module';
import { HealthController } from './modules/health/health.controller';
import { LogixModule } from './modules/logix/logix.module';
import { MuzaloModule } from './modules/muzalo/muzalo.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { QuantumModule } from './modules/quantum/quantum.module';

const platformModules = [
  AppsModule,
  FirebaseAdminModule,
  AuthModule,
];

const sharedServiceModules = [
  AiModule,
  BillingModule,
  EmailModule,
  NotificationsModule,
];

const productModules = [
  AcademyMobileModule,
  AcademySdkModule,
  CoursesModule,
  DrippybanksModule,
  FlowModule,
  InfinityModule,
  LogixModule,
  MuzaloModule,
  QuantumModule,
];

@Module({
  imports: [
    ...platformModules,
    ...sharedServiceModules,
    ...productModules,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestLoggerMiddleware, RateLimitMiddleware).forRoutes('*');
  }
}
