import { Module } from '@nestjs/common';
import { EmailController } from './email.controller';
import { ResendService } from './resend.service';

@Module({
  controllers: [EmailController],
  providers: [ResendService],
  exports: [ResendService],
})
export class EmailModule {}
