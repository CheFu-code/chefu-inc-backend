import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MuzaloController } from './muzalo.controller';
import { MuzaloService } from './muzalo.service';

@Module({
  imports: [AuthModule],
  controllers: [MuzaloController],
  providers: [MuzaloService],
})
export class MuzaloModule {}
