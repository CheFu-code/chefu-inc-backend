import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AdminGuard } from './admin.guard';
import { AuthGuard } from './auth.guard';
import { SessionSignerService } from './session-signer.service';

@Module({
  controllers: [AuthController],
  providers: [AuthGuard, AdminGuard, SessionSignerService],
  exports: [AuthGuard, AdminGuard, SessionSignerService],
})
export class AuthModule {}
