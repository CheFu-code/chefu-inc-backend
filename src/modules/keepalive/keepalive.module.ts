import { Module } from '@nestjs/common';
import { KeepaliveService } from './keepalive.service';

@Module({
  providers: [KeepaliveService],
})
export class KeepaliveModule {}
