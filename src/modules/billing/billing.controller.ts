import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { BillingService } from './billing.service';

type BillingRequest = Request & {
  rawBody?: Buffer;
  user?: AuthenticatedUser;
};

@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @UseGuards(AuthGuard)
  @Get('status')
  getStatus(@Req() request: BillingRequest) {
    return this.billingService.getBillingStatus(this.requireUser(request));
  }

  @UseGuards(AuthGuard)
  @Post('checkout')
  createCheckout(@Req() request: BillingRequest) {
    return this.billingService.createCheckoutSession(this.requireUser(request));
  }

  @UseGuards(AuthGuard)
  @Post('portal')
  createPortal(@Req() request: BillingRequest) {
    return this.billingService.createPortalSession(this.requireUser(request));
  }

  @Post('webhook/clerk')
  handleClerkWebhook(@Req() request: BillingRequest, @Body() body: unknown) {
    const rawBody =
      request.rawBody ||
      Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));

    return this.billingService.handleClerkWebhook(rawBody, {
      'svix-id': this.header(request, 'svix-id'),
      'svix-timestamp': this.header(request, 'svix-timestamp'),
      'svix-signature': this.header(request, 'svix-signature'),
    });
  }

  private requireUser(request: BillingRequest) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user missing from request.');
    }

    return request.user;
  }

  private header(request: Request, name: string) {
    const value = request.headers[name];
    return Array.isArray(value) ? value.join(' ') : value || '';
  }
}
