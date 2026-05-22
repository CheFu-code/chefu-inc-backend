import { Controller, Get, Head } from '@nestjs/common';

export class HealthController {
  @Get()
  root() {
    return this.status();
  }

  @Head()
  rootHead() {
    return;
  }

  @Get('health')
  check() {
    return this.status();
  }

  private status() {
    return {
      ok: true,
      service: 'chefu-api',
      timestamp: new Date().toISOString(),
    };
  }
}
