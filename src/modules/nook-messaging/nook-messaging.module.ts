import { Module } from '@nestjs/common';
import { NookMessagingController } from './nook-messaging.controller';
import { NookMessagingService } from './nook-messaging.service';

@Module({
  controllers: [NookMessagingController],
  providers: [NookMessagingService],
})
export class NookMessagingModule {}