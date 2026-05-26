import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import cron, { ScheduledTask } from 'node-cron';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

@Injectable()
export class AcademySdkCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AcademySdkCleanupService.name);
  private task?: ScheduledTask;

  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

  onModuleInit() {
    const cronExpression = process.env.SDK_API_KEY_CLEANUP_CRON || '0 0 * * *';

    if (!cron.validate(cronExpression)) {
      this.logger.error(
        JSON.stringify({
          event: 'academy_sdk_cleanup_invalid_cron',
          cronExpression,
        }),
      );
      return;
    }

    this.task = cron.schedule(cronExpression, () => {
      void this.deactivateUnusedKeys();
    });

    this.logger.log(
      JSON.stringify({
        event: 'academy_sdk_cleanup_started',
        cronExpression,
      }),
    );
  }

  onModuleDestroy() {
    void this.task?.stop();
  }

  private async deactivateUnusedKeys() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);

    try {
      const snapshot = await this.firebaseAdmin
        .db()
        .collection('api_keys')
        .where('active', '==', true)
        .where('lastUsedAt', '<', cutoff)
        .get();

      if (snapshot.empty) {
        this.logger.log(
          JSON.stringify({
            event: 'academy_sdk_cleanup_finished',
            deactivated: 0,
          }),
        );
        return;
      }

      const batch = this.firebaseAdmin.db().batch();
      snapshot.docs.forEach(doc => {
        batch.update(doc.ref, { active: false });
      });
      await batch.commit();

      this.logger.log(
        JSON.stringify({
          event: 'academy_sdk_cleanup_finished',
          deactivated: snapshot.size,
        }),
      );
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'academy_sdk_cleanup_failed',
          reason: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }
  }
}
