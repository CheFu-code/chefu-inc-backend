import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmailController } from './email.controller';
import { MfaSecurityEmailService } from './mfa-security-email.service';
import { ResendService } from './resend.service';

@Module({
  imports: [forwardRef(() => AuthModule)],
  controllers: [EmailController],
  providers: [MfaSecurityEmailService, ResendService],
  exports: [MfaSecurityEmailService, ResendService],
})
export class EmailModule {}
