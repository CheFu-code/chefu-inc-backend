import { Controller, Get, Head } from "@nestjs/common";

@Controller()
export class HealthController {
  @Get()
  root() {
    return this.status();
  }

  @Head()
  rootHead() {
    return;
  }

  @Get("health")
  check() {
    return this.status();
  }

  @Get("debug-sentry")
  getError() {
    throw new Error("My first Sentry error!");
  }

  private status() {
    return {
      ok: true,
      service: "chefu-api",
      timestamp: new Date().toISOString(),
    };
  }
}
