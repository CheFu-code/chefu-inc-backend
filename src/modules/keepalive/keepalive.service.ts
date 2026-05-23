import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import cron, { ScheduledTask } from 'node-cron';

@Injectable()
export class KeepaliveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KeepaliveService.name);
  private task?: ScheduledTask;

  onModuleInit() {
    const url = this.getPingUrl();
    const cronExpression = process.env.KEEPALIVE_CRON || '*/14 * * * *';

    if (!cron.validate(cronExpression)) {
      this.logger.error(
        JSON.stringify({
          event: 'keepalive_invalid_cron',
          cronExpression,
        }),
      );
      return;
    }

    this.task = cron.schedule(cronExpression, () => {
      void this.ping(url);
    });

    this.logger.log(
      JSON.stringify({
        event: 'keepalive_started',
        url,
        cronExpression,
      }),
    );
  }

  onModuleDestroy() {
    void this.task?.stop();
  }

  private async ping(url: string) {
    const startedAt = Date.now();

    try {
      const response = await fetch(url, {
        method: process.env.KEEPALIVE_METHOD || 'GET',
        headers: {
          'User-Agent': 'CheFu-Academy-Keepalive/1.0',
        },
      });

      this.logger.log(
        JSON.stringify({
          event: 'keepalive_ping_finished',
          statusCode: response.status,
          ok: response.ok,
          durationMs: Date.now() - startedAt,
        }),
      );
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'keepalive_ping_failed',
          reason: error instanceof Error ? error.message : 'unknown',
          durationMs: Date.now() - startedAt,
        }),
      );
    }
  }

  private getPingUrl() {
    const configuredUrl = process.env.KEEPALIVE_PING_URL?.trim();
    if (configuredUrl) return configuredUrl;

    const renderExternalUrl = process.env.RENDER_EXTERNAL_URL?.trim();
    if (renderExternalUrl) {
      return `${this.trimTrailingSlash(renderExternalUrl)}/health`;
    }

    const port = process.env.PORT || '4000';
    return `http://127.0.0.1:${port}/health`;
  }

  private trimTrailingSlash(value: string) {
    return value.replace(/\/+$/, '');
  }
}
