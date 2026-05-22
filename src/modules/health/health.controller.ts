import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return {
      ok: true,
      service: 'chefu-api',
      timestamp: new Date().toISOString(),
    };
  }
}
