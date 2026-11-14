import { Body, Controller, Get, Header, HttpCode, HttpException, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { getClientIp } from '../../common/security-audit';
import { CheckCodeDto, SendCodeDto } from './phone-verification.dto';
import { PhoneVerificationService } from './phone-verification.service';

type PhoneRequest = Request & { user: AuthenticatedUser };
@Controller('phone-verification')
@UseGuards(AuthGuard)
export class PhoneVerificationController {
  constructor(private readonly verification: PhoneVerificationService) {}

  @Get('status')
  @Header('Cache-Control', 'private, no-store')
  status(@Req() req: PhoneRequest) { return this.verification.status(req.user.uid); }

  @Post('send')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  send(@Req() req: PhoneRequest, @Body() dto: SendCodeDto, @Res({ passthrough: true }) response: Response) {
    return this.execute(response, () => this.verification.sendCode(req.user.uid, dto.phone, getClientIp(req)));
  }

  @Post('check')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  check(@Req() req: PhoneRequest, @Body() dto: CheckCodeDto, @Res({ passthrough: true }) response: Response) {
    return this.execute(response, () => this.verification.checkCode(req.user.uid, dto.phone, dto.code, getClientIp(req), req.user.email));
  }

  private async execute<T>(response: Response, operation: () => Promise<T>) {
    try { return await operation(); }
    catch (cause) {
      if (cause instanceof HttpException && cause.getStatus() === 429) {
        const payload = cause.getResponse() as { retryAfterSeconds?: number };
        if (payload.retryAfterSeconds) response.setHeader('Retry-After', String(payload.retryAfterSeconds));
      }
      throw cause;
    }
  }
}
