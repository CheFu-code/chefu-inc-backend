import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { CloudenceBillingService } from './cloudence-billing.service';
import { GooglePlayPublisherService } from './google-play-publisher.service';
import { GOOGLE_PLAY_PACKAGE_NAME } from './google-play-billing.constants';

type PubSubMessage = {
  data?: string;
  messageId?: string;
};

type PlayNotification = {
  packageName?: string;
  subscriptionNotification?: {
    notificationType?: number;
    purchaseToken?: string;
  };
  voidedPurchaseNotification?: {
    purchaseToken?: string;
  };
  testNotification?: Record<string, unknown>;
};

@Controller('cloudence/billing/google-play')
export class GooglePlayRtdnController {
  constructor(
    private readonly billing: CloudenceBillingService,
    private readonly googlePlay: GooglePlayPublisherService,
  ) {}

  @Post('notifications')
  async receive(
    @Headers('authorization') authorization: string | undefined,
    @Req() request: Request & { body?: { message?: PubSubMessage } },
  ) {
    const idToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (
      !idToken ||
      !(await this.googlePlay.verifyNotificationToken(idToken))
    ) {
      throw new UnauthorizedException('Invalid Google Play notification.');
    }
    const encoded = request.body?.message?.data;
    if (typeof encoded !== 'string' || encoded.length > 100_000) {
      throw new BadRequestException('Invalid Pub/Sub notification payload.');
    }

    let notification: PlayNotification;
    try {
      notification = JSON.parse(
        Buffer.from(encoded, 'base64').toString('utf8'),
      ) as PlayNotification;
    } catch {
      throw new BadRequestException('Invalid Google Play notification data.');
    }
    if (notification.packageName !== GOOGLE_PLAY_PACKAGE_NAME) {
      throw new BadRequestException('Notification package does not match.');
    }
    if (notification.testNotification) return { received: true };

    const subscription = notification.subscriptionNotification;
    const purchaseToken =
      subscription?.purchaseToken ??
      notification.voidedPurchaseNotification?.purchaseToken;
    if (!purchaseToken) return { received: true };

    const revoked =
      Boolean(notification.voidedPurchaseNotification) ||
      subscription?.notificationType === 12;
    return this.billing.handleNotification(purchaseToken, revoked);
  }
}
