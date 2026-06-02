import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailController } from './email.controller';
import { ResendService } from './resend.service';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [EmailController],
  providers: [ResendService],
  exports: [ResendService],
})
export class EmailModule {}
