import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import cron, { ScheduledTask } from 'node-cron';
import { DrippybanksService } from './drippybanks.service';

@Injectable()
export class DrippybanksOrderCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DrippybanksOrderCleanupService.name);
  private task?: ScheduledTask;

  constructor(private readonly drippybanksService: DrippybanksService) {}

  onModuleInit() {
    // Default to running every 30 minutes
    const cronExpression =
      process.env.DRIPPYBANKS_ORDER_CLEANUP_CRON || '*/30 * * * *';

    if (!cron.validate(cronExpression)) {
      this.logger.error(
        JSON.stringify({
          event: 'drippybanks_order_cleanup_invalid_cron',
          cronExpression,
        }),
      );
      return;
    }

    this.task = cron.schedule(cronExpression, () => {
      void this.runCleanup();
    });

    this.logger.log(
      JSON.stringify({
        event: 'drippybanks_order_cleanup_scheduled',
        cronExpression,
      }),
    );
  }

  onModuleDestroy() {
    void this.task?.stop();
  }

  async runCleanup(timeoutMinutes?: number) {
    try {
      const minutes =
        timeoutMinutes ??
        Number(process.env.DRIPPYBANKS_PENDING_ORDER_TIMEOUT_MINUTES || 60);

      const result =
        await this.drippybanksService.cleanupExpiredPendingOrders(minutes);

      if (result.cancelledCount > 0) {
        this.logger.log(
          JSON.stringify({
            event: 'drippybanks_cron_order_cleanup_success',
            cancelled: result.cancelledCount,
            orderIds: result.orderIds,
          }),
        );
      }

      return result;
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'drippybanks_cron_order_cleanup_failed',
          reason: error instanceof Error ? error.message : 'unknown',
        }),
      );
      throw error;
    }
  }
}
