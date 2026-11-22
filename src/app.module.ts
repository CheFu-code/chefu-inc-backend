import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { RateLimitMiddleware } from './common/rate-limit.middleware';
import { RequestLoggerMiddleware } from './common/request-logger.middleware';
import { AiModule } from './modules/ai/ai.module';
import { AppsModule } from './modules/apps/apps.module';
import { AuthModule } from './modules/auth/auth.module';
import { EmailModule } from './modules/email/email.module';
import { FirebaseAdminModule } from './modules/firebase-admin/firebase-admin.module';
import { HealthController } from './modules/health/health.controller';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { QuantumModule } from './modules/quantum/quantum.module';
import { ProductsModule } from './modules/products/products.module';
import { SubmissionsModule } from './modules/submissions/submissions.module';
import { SentryModule } from '@sentry/nestjs/setup';
import { CloudenceModule } from './modules/cloudence/cloudence.module';
import { LiftWiseModule } from './modules/liftwise/liftwise.module';
import { StoreModule } from './modules/store/store.module';
import { ShopYethuModule } from './modules/shopyethu/shopyethu.module';
import { UserManagementModule } from './modules/user-management/user-management.module';

const platformModules = [
  AppsModule,
  FirebaseAdminModule,
  AuthModule,
  UserManagementModule,
];

const sharedServiceModules = [
  AiModule,
  EmailModule,
  NotificationsModule,
];

const productModules = [
  QuantumModule,
  ProductsModule,
  SubmissionsModule,
  CloudenceModule,
  LiftWiseModule,
  StoreModule,
  ShopYethuModule,
];

@Module({
  imports: [
    SentryModule.forRoot(),
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
