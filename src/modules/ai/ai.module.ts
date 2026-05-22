import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiController } from './ai.controller';

@Module({
  imports: [AuthModule],
  controllers: [AiController],
})
export class AiModule {}
