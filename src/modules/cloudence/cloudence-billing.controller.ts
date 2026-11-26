import {
  BadRequestException,
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
import { CloudenceBillingService } from './cloudence-billing.service';

type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

@Controller('cloudence/billing/google-play')
@UseGuards(AuthGuard)
export class CloudenceBillingController {
  constructor(private readonly billing: CloudenceBillingService) {}

  @Get('status')
  status() {
    return this.billing.status();
  }

  @Post('verify')
  verify(
    @Req() request: AuthenticatedRequest,
    @Body() body: { productId?: unknown; purchaseToken?: unknown },
  ) {
    const user = this.requireUser(request);
    if (
      typeof body?.productId !== 'string' ||
      typeof body.purchaseToken !== 'string'
    ) {
      throw new BadRequestException(
        'A product ID and purchase token are required.',
      );
    }
    return this.billing.verifyPurchase(
      user.uid,
      body.productId,
      body.purchaseToken,
    );
  }

  private requireUser(request: AuthenticatedRequest) {
    if (!request.user) {
      throw new UnauthorizedException(
        'Authenticated user missing from request.',
      );
    }
    return request.user;
  }
}
