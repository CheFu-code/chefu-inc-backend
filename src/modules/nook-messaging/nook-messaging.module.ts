import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NookMessagingController } from './nook-messaging.controller';
import { NookMessagingService } from './nook-messaging.service';

@Module({
  imports: [AuthModule],
  controllers: [NookMessagingController],
  providers: [NookMessagingService],
})
export class NookMessagingModule {}