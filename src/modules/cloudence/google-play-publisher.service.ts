import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GoogleAuth, OAuth2Client, type JWTInput } from 'google-auth-library';
import {
  GOOGLE_PLAY_PACKAGE_NAME,
  GooglePlaySubscriptionPurchase,
} from './google-play-billing.constants';

const ANDROID_PUBLISHER_SCOPE =
  'https://www.googleapis.com/auth/androidpublisher';
const ANDROID_PUBLISHER_URL =
  'https://androidpublisher.googleapis.com/androidpublisher/v3';

@Injectable()
export class GooglePlayPublisherService {
  private readonly logger = new Logger(GooglePlayPublisherService.name);

  isConfigured() {
    return (
      process.env.GOOGLE_PLAY_BILLING_ENABLED === 'true' &&
      process.env.GOOGLE_PLAY_PACKAGE_NAME === GOOGLE_PLAY_PACKAGE_NAME &&
      Boolean(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?.trim()) &&
      Boolean(process.env.GOOGLE_PLAY_RTDN_AUDIENCE?.trim()) &&
      Boolean(process.env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL?.trim())
    );
  }

  async getSubscription(purchaseToken: string) {
    const url = `${ANDROID_PUBLISHER_URL}/applications/${encodeURIComponent(
      GOOGLE_PLAY_PACKAGE_NAME,
    )}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
    return this.request<GooglePlaySubscriptionPurchase>(url, 'GET');
  }

  async acknowledge(productId: string, purchaseToken: string) {
    const url = `${ANDROID_PUBLISHER_URL}/applications/${encodeURIComponent(
      GOOGLE_PLAY_PACKAGE_NAME,
    )}/purchases/subscriptions/${encodeURIComponent(
      productId,
    )}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;
    await this.request<unknown>(url, 'POST', {});
  }

  async verifyNotificationToken(idToken: string) {
    const audience = process.env.GOOGLE_PLAY_RTDN_AUDIENCE?.trim();
    const expectedEmail =
      process.env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL?.trim();
    if (!audience || !expectedEmail) {
      throw new ServiceUnavailableException(
        'Google Play notifications are not configured.',
      );
    }

    try {
      const ticket = await new OAuth2Client().verifyIdToken({
        idToken,
        audience,
      });
      const payload = ticket.getPayload();
      return (
        payload?.email === expectedEmail &&
        payload.email_verified === true
      );
    } catch {
      return false;
    }
  }

  private async request<T>(
    url: string,
    method: 'GET' | 'POST',
    data?: Record<string, never>,
  ): Promise<T> {
    const client = await this.publisherClient();
    try {
      const response = await client.request<T>({ url, method, data });
      return response.data;
    } catch (error) {
      const response =
        typeof error === 'object' && error !== null
          ? Reflect.get(error, 'response')
          : undefined;
      const status =
        typeof response === 'object' && response !== null
          ? Reflect.get(response, 'status')
          : undefined;
      this.logger.error(
        `Google Play Publisher API request failed (status ${String(status ?? 'unknown')}).`,
      );
      if (status === 400 || status === 404) {
        throw new BadGatewayException(
          'Google Play could not verify this purchase.',
        );
      }
      throw new ServiceUnavailableException(
        'Google Play verification is temporarily unavailable.',
      );
    }
  }

  private async publisherClient() {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Google Play billing is not configured.',
      );
    }

    let credentials: JWTInput;
    try {
      credentials = JSON.parse(
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON!,
      ) as JWTInput;
    } catch {
      throw new ServiceUnavailableException(
        'Google Play billing credentials are invalid.',
      );
    }
    if (
      typeof credentials.client_email !== 'string' ||
      typeof credentials.private_key !== 'string'
    ) {
      throw new ServiceUnavailableException(
        'Google Play billing credentials are invalid.',
      );
    }

    try {
      const auth = new GoogleAuth({
        credentials,
        scopes: [ANDROID_PUBLISHER_SCOPE],
      });
      return await auth.getClient();
    } catch {
      throw new ServiceUnavailableException(
        'Google Play billing credentials are invalid.',
      );
    }
  }
}
