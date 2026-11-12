import { Body, Controller, Get, Header, Headers, HttpCode, Inject, Logger, Post, RawBodyRequest, Req, UnauthorizedException, UseGuards, ValidationPipe } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { CheckoutService } from './checkout.service';
import { CHECKOUT_COOKIE, validateReference } from './checkout.validation';
import { PaystackService } from './paystack.service';
import { CheckoutAccessGuard, CheckoutRequest } from './checkout-access.guard';
import { CheckoutDto, CheckoutReferenceDto } from './checkout.dto';
const dtoPipe = (type: typeof CheckoutDto | typeof CheckoutReferenceDto) => new ValidationPipe({ expectedType: type, whitelist: true, forbidNonWhitelisted: true, transform: true });

@Controller('store/checkout')
export class CheckoutController {
  private readonly logger = new Logger(CheckoutController.name);
  constructor(@Inject(CheckoutService) private readonly checkout: CheckoutService, @Inject(PaystackService) private readonly paystack: PaystackService) {}

  @Post('initialize')
  @UseGuards(CheckoutAccessGuard)
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  initialize(@Req() request: CheckoutRequest, @Headers('idempotency-key') key: string, @Body(dtoPipe(CheckoutDto)) body: CheckoutDto) {
    return this.checkout.initialize(request.user!.uid, key, body);
  }

  @Post('verify')
  @UseGuards(CheckoutAccessGuard)
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  verify(@Req() request: CheckoutRequest, @Body(dtoPipe(CheckoutReferenceDto)) body: CheckoutReferenceDto) {
    return this.checkout.verify(request.user?.uid, validateReference(body), this.owner(request));
  }

  @Get('recover')
  @UseGuards(CheckoutAccessGuard)
  @Header('Cache-Control', 'private, no-store')
  recover(@Req() request: CheckoutRequest) { return this.checkout.recover(request.user!.uid); }

  @Get('orders')
  @UseGuards(CheckoutAccessGuard)
  @Header('Cache-Control', 'private, no-store')
  orders(@Req() request: CheckoutRequest) { return this.checkout.history(request.user!.uid); }

  @Post('acknowledge')
  @UseGuards(CheckoutAccessGuard)
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  acknowledge(@Req() request: CheckoutRequest, @Body(dtoPipe(CheckoutReferenceDto)) body: CheckoutReferenceDto) { return this.checkout.acknowledge(request.user!.uid, validateReference(body)); }

  @Post('claim-legacy')
  @UseGuards(CheckoutAccessGuard)
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  claim(@Req() request: CheckoutRequest, @Body(dtoPipe(CheckoutReferenceDto)) body: CheckoutReferenceDto) {
    const guest = this.owner(request);
    if (!guest) throw new UnauthorizedException('The original checkout cookie is required.');
    return this.checkout.claimLegacy(request.user!.uid, validateReference(body), guest);
  }

  @Post('webhook')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  webhook(@Req() request: RawBodyRequest<Request>, @Body() body: unknown) {
    try { this.paystack.authenticateWebhook(request.rawBody, request.get('paystack-signature'), request.get('x-paystack-signature')); }
    catch (error) { this.logger.warn(JSON.stringify({ event: 'store_webhook_signature_rejected' })); throw error; }
    return this.checkout.webhook(body, createHash('sha256').update(request.rawBody!).digest('hex'));
  }

  private owner(request: Request): string | undefined {
    const value: unknown = request.cookies?.[CHECKOUT_COOKIE];
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
  }
}
