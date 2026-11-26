import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OAuth2Client, type IdentityPoolClient } from 'google-auth-library';
import { validateGooglePlayBillingEnv } from '../../common/env';
import { readGooglePlayFederationConfig } from './google-play-auth.config';
import { createGooglePlayFederatedClient } from './google-play-federation';
import {
  GOOGLE_PLAY_PACKAGE_NAME,
  GooglePlaySubscriptionPurchase,
} from './google-play-billing.constants';

const ANDROID_PUBLISHER_URL =
  'https://androidpublisher.googleapis.com/androidpublisher/v3';

@Injectable()
export class GooglePlayPublisherService {
  private readonly logger = new Logger(GooglePlayPublisherService.name);
  private client?: IdentityPoolClient;

  isConfigured() {
    return (
      process.env.GOOGLE_PLAY_BILLING_ENABLED === 'true' &&
      validateGooglePlayBillingEnv().missing.length === 0
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
    const client = this.publisherClient();
    try {
      await client.getAccessToken();
    } catch {
      // Auth responses can contain subject tokens. Do not log or return them.
      throw new ServiceUnavailableException(
        'Google Play workload identity authentication is unavailable.',
      );
    }
    try {
      const response = await client.request<T>({ url, method, data });
      return response.data;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
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

  private publisherClient() {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Google Play billing is not configured.',
      );
    }

    const config = readGooglePlayFederationConfig();
    if (!config) {
      throw new ServiceUnavailableException(
        'Google Play workload identity is not configured.',
      );
    }
    // Reuse Google's expiring credential cache and automatic refresh handling.
    this.client ??= createGooglePlayFederatedClient(config);
    return this.client;
  }
}
