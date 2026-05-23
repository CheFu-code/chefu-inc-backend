import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import admin from 'firebase-admin';
import { Webhook } from 'svix';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import {
  BillingHistoryItem,
  BillingStatusResponse,
  BillingUser,
  ClerkWebhookEvent,
  NormalizedBillingStatus,
} from './billing.types';

type FirestoreData = FirebaseFirestore.DocumentData;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

  async getBillingStatus(user: BillingUser): Promise<BillingStatusResponse> {
    const userDoc = await this.firebaseAdmin
      .db()
      .collection('users')
      .doc(user.email)
      .get();

    const data = userDoc.data() || {};
    const billing = this.toBillingPayload(data);
    const history = await this.getBillingHistory(user.email);

    return { billing, history };
  }

  createCheckoutSession(user: BillingUser) {
    const planId =
      process.env.CLERK_BILLING_PLAN_ID || 'cplan_3E6vfLRRJBC9t4HfgdUWZJuLPuh';
    const planPeriod = process.env.CLERK_BILLING_PLAN_PERIOD || 'month';

    return {
      clientReferenceId: user.uid,
      email: user.email,
      planId,
      planPeriod,
    };
  }

  createPortalSession(user: BillingUser) {
    const portalUrl = this.requiredUrl(
      process.env.CLERK_BILLING_PORTAL_URL,
      'CLERK_BILLING_PORTAL_URL',
    );

    return {
      url: this.withReturnParams(portalUrl, user),
    };
  }

  async handleClerkWebhook(rawBody: Buffer | string, headers: Record<string, string>) {
    const event = this.verifyWebhook(rawBody, headers);
    const type = event.type || 'unknown';
    const normalized = this.normalizeClerkEvent(event);

    this.logger.log(
      JSON.stringify({
        event: 'clerk_billing_webhook_received',
        type,
        email: normalized.email || null,
        externalUserId: normalized.externalUserId || null,
        planName: normalized.planName || null,
        status: normalized.status || null,
      }),
    );

    if (type.startsWith('subscriptionItem.') || type.startsWith('subscription.')) {
      await this.syncSubscription(normalized, type);
    }

    if (type.startsWith('paymentAttempt.')) {
      await this.recordPayment(normalized, type);
    }

    return { received: true };
  }

  private verifyWebhook(rawBody: Buffer | string, headers: Record<string, string>) {
    const secret = process.env.CLERK_WEBHOOK_SECRET;

    if (!secret) {
      throw new ServiceUnavailableException('Clerk webhook secret is not configured.');
    }

    const svixId = headers['svix-id'];
    const svixTimestamp = headers['svix-timestamp'];
    const svixSignature = headers['svix-signature'];

    if (!svixId || !svixTimestamp || !svixSignature) {
      throw new UnauthorizedException('Missing Clerk webhook signature headers.');
    }

    const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;

    try {
      return new Webhook(secret).verify(payload, {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': svixSignature,
      }) as ClerkWebhookEvent;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'clerk_billing_webhook_rejected',
          reason: error instanceof Error ? error.message : 'unknown',
        }),
      );
      throw new UnauthorizedException('Invalid Clerk webhook signature.');
    }
  }

  private async syncSubscription(normalized: NormalizedBillingStatus, eventType: string) {
    const email = await this.resolveEmail(normalized);

    if (!email) {
      this.logger.warn(
        JSON.stringify({
          event: 'clerk_billing_subscription_skipped',
          eventType,
          reason: 'missing_email',
          externalUserId: normalized.externalUserId || null,
        }),
      );
      return;
    }

    const status = normalized.status || this.statusFromEvent(eventType);
    const active = this.isActiveSubscriptionStatus(status);
    const now = admin.firestore.FieldValue.serverTimestamp();

    await this.firebaseAdmin
      .db()
      .collection('users')
      .doc(email)
      .set(
        {
          billing: {
            customerId: normalized.customerId || null,
            externalUserId: normalized.externalUserId || null,
            planId: normalized.planId || null,
            planName: normalized.planName || this.planNameFromStatus(status),
            provider: 'clerk',
            status,
            subscriptionId: normalized.subscriptionId || null,
            updatedAt: now,
          },
          member: active,
          memberUntil: normalized.periodEnd
            ? admin.firestore.Timestamp.fromDate(normalized.periodEnd)
            : null,
          subscriptionStatus: active
            ? normalized.planName || this.planNameFromStatus(status)
            : 'free',
          updatedAt: now,
        },
        { merge: true },
      );

    this.logger.log(
      JSON.stringify({
        event: 'clerk_billing_subscription_synced',
        email,
        status,
        active,
        planName: normalized.planName || null,
      }),
    );
  }

  private async recordPayment(normalized: NormalizedBillingStatus, eventType: string) {
    const email = await this.resolveEmail(normalized);

    if (!email) {
      this.logger.warn(
        JSON.stringify({
          event: 'clerk_billing_payment_skipped',
          eventType,
          reason: 'missing_email',
          externalUserId: normalized.externalUserId || null,
        }),
      );
      return;
    }

    const status = normalized.status || this.statusFromEvent(eventType);
    const paymentId =
      normalized.checkoutId ||
      `${eventType}:${normalized.subscriptionId || email}:${Date.now()}`;

    await this.firebaseAdmin
      .db()
      .collection('payments')
      .doc(paymentId)
      .set(
        {
          amount: {
            currency_code: normalized.currency || 'USD',
            value: normalized.amount || '0.00',
          },
          email,
          orderID: paymentId,
          payerID: normalized.customerId || normalized.externalUserId || '',
          payerName: normalized.payerName || {
            given_name: '',
            surname: '',
          },
          planType: normalized.planName || 'Subscription',
          provider: 'clerk',
          status: this.paymentStatus(status),
          timestamp: normalized.paidAt || new Date(),
        },
        { merge: true },
      );

    this.logger.log(
      JSON.stringify({
        event: 'clerk_billing_payment_recorded',
        email,
        paymentId,
        status,
      }),
    );
  }

  private async resolveEmail(normalized: NormalizedBillingStatus) {
    if (normalized.email) return normalized.email.toLowerCase();

    if (!normalized.externalUserId) return null;

    const snapshot = await this.firebaseAdmin
      .db()
      .collection('users')
      .where('billing.externalUserId', '==', normalized.externalUserId)
      .limit(1)
      .get();

    const doc = snapshot.docs.at(0);
    const email = doc?.id || doc?.data().email;
    return typeof email === 'string' ? email.toLowerCase() : null;
  }

  private normalizeClerkEvent(event: ClerkWebhookEvent): NormalizedBillingStatus {
    const data = event.data || {};
    const payer = this.objectValue(data.payer) || this.objectValue(data.user) || {};
    const plan = this.objectValue(data.plan) || this.objectValue(data.plan_snapshot) || {};
    const subscription =
      this.objectValue(data.subscription) || this.objectValue(data.subscription_item) || {};
    const paymentAttempt =
      this.objectValue(data.payment_attempt) || this.objectValue(data.paymentAttempt) || {};
    const amountValue =
      this.valueAt(data, 'amount') ??
      this.valueAt(paymentAttempt, 'amount') ??
      this.valueAt(data, 'amount_paid') ??
      this.valueAt(data, 'total');
    const periodEnd =
      this.dateFrom(data.period_end) ||
      this.dateFrom(data.current_period_end) ||
      this.dateFrom(subscription.period_end) ||
      this.dateFrom(subscription.current_period_end);

    return {
      amount: this.formatAmount(amountValue),
      checkoutId: this.stringValue(data.id) || this.stringValue(paymentAttempt.id) || undefined,
      currency:
        this.stringValue(data.currency) ||
        this.stringValue(paymentAttempt.currency) ||
        'USD',
      customerId:
        this.stringValue(data.customer_id) ||
        this.stringValue(data.customerId) ||
        this.stringValue(payer.customer_id) ||
        undefined,
      email:
        this.emailFrom(data) ||
        this.emailFrom(payer) ||
        this.stringValue(data.email_address) ||
        this.stringValue(data.email) ||
        undefined,
      externalUserId:
        this.stringValue(data.user_id) ||
        this.stringValue(data.userId) ||
        this.stringValue(data.clerk_user_id) ||
        this.stringValue(payer.user_id) ||
        this.stringValue(payer.id) ||
        undefined,
      paidAt:
        this.dateFrom(data.paid_at) ||
        this.dateFrom(data.updated_at) ||
        this.dateFrom(data.created_at) ||
        this.dateFrom(event.timestamp) ||
        undefined,
      payerName: {
        given_name:
          this.stringValue(payer.first_name) || this.stringValue(data.first_name) || '',
        surname: this.stringValue(payer.last_name) || this.stringValue(data.last_name) || '',
      },
      periodEnd: periodEnd || undefined,
      planId:
        this.stringValue(data.plan_id) ||
        this.stringValue(plan.id) ||
        this.stringValue(subscription.plan_id) ||
        undefined,
      planName:
        this.stringValue(data.plan_name) ||
        this.stringValue(plan.name) ||
        this.stringValue(plan.slug) ||
        this.stringValue(subscription.plan_name) ||
        undefined,
      status: this.stringValue(data.status) || this.stringValue(subscription.status) || undefined,
      subscriptionId:
        this.stringValue(data.subscription_id) ||
        this.stringValue(subscription.id) ||
        this.stringValue(data.id) ||
        undefined,
    };
  }

  private async getBillingHistory(email: string) {
    const snapshot = await this.firebaseAdmin
      .db()
      .collection('payments')
      .where('email', '==', email)
      .limit(20)
      .get();

    return snapshot.docs
      .map(doc => this.toBillingHistoryItem(doc.id, doc.data()))
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  }

  private toBillingPayload(data: FirestoreData): BillingStatusResponse['billing'] {
    const billing = this.objectValue(data.billing) || {};
    const memberUntil = this.dateFrom(data.memberUntil);
    const updatedAt = this.dateFrom(billing.updatedAt);

    return {
      customerId: this.stringValue(billing.customerId),
      member: Boolean(data.member),
      memberUntil: memberUntil ? memberUntil.toISOString() : null,
      planId: this.stringValue(billing.planId),
      planName:
        this.stringValue(billing.planName) ||
        this.stringValue(data.subscriptionStatus) ||
        'Free',
      provider: this.stringValue(billing.provider) || 'clerk',
      status: this.stringValue(billing.status) || this.stringValue(data.subscriptionStatus) || 'free',
      subscriptionId: this.stringValue(billing.subscriptionId),
      updatedAt: updatedAt ? updatedAt.toISOString() : null,
    };
  }

  private toBillingHistoryItem(id: string, data: FirestoreData): BillingHistoryItem {
    const amount = this.objectValue(data.amount) || {};
    const payerName = this.objectValue(data.payerName) || {};
    const timestamp = this.dateFrom(data.timestamp) || new Date();

    return {
      amount: {
        currency_code: this.stringValue(amount.currency_code) || 'USD',
        value: this.stringValue(amount.value) || '0.00',
      },
      email: this.stringValue(data.email) || '',
      orderID: this.stringValue(data.orderID) || id,
      payerID: this.stringValue(data.payerID) || '',
      payerName: {
        given_name: this.stringValue(payerName.given_name) || '',
        surname: this.stringValue(payerName.surname) || '',
      },
      planType: this.stringValue(data.planType) || 'Subscription',
      status: this.stringValue(data.status) || 'UNKNOWN',
      timestamp: timestamp.toISOString(),
    };
  }

  private requiredUrl(value: string | undefined, name: string) {
    if (!value) {
      throw new ServiceUnavailableException(`${name} is not configured.`);
    }

    try {
      return new URL(value);
    } catch {
      throw new ServiceUnavailableException(`${name} must be a valid URL.`);
    }
  }

  private withReturnParams(url: URL, user: BillingUser) {
    const copy = new URL(url.toString());
    const appUrl = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';

    copy.searchParams.set('redirect_url', `${appUrl.replace(/\/+$/, '')}/settings/billing`);
    copy.searchParams.set('client_reference_id', user.uid);
    copy.searchParams.set('prefilled_email', user.email);

    return copy.toString();
  }

  private emailFrom(value: FirestoreData) {
    const direct = this.stringValue(value.email) || this.stringValue(value.email_address);
    if (direct) return direct.toLowerCase();

    const emails = value.email_addresses;
    if (Array.isArray(emails)) {
      const first = emails.at(0);
      if (first && typeof first === 'object') {
        return this.stringValue((first as Record<string, unknown>).email_address)?.toLowerCase();
      }
    }

    return null;
  }

  private objectValue(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private stringValue(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private valueAt(value: Record<string, unknown>, key: string) {
    return value[key];
  }

  private dateFrom(value: unknown) {
    if (!value) return null;

    if (value instanceof Date) return value;

    if (value instanceof admin.firestore.Timestamp) {
      return value.toDate();
    }

    if (
      typeof value === 'object' &&
      'toDate' in value &&
      typeof value.toDate === 'function'
    ) {
      return value.toDate() as Date;
    }

    if (typeof value === 'number') {
      const milliseconds = value > 10_000_000_000 ? value : value * 1000;
      return new Date(milliseconds);
    }

    if (typeof value === 'string') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    return null;
  }

  private formatAmount(value: unknown) {
    if (typeof value === 'number') {
      return value > 1000 ? (value / 100).toFixed(2) : value.toFixed(2);
    }

    if (typeof value === 'string' && value.trim()) return value;

    return undefined;
  }

  private statusFromEvent(eventType: string) {
    const [, status] = eventType.split('.');
    return status || 'unknown';
  }

  private isActiveSubscriptionStatus(status: string) {
    return ['active', 'paid', 'trialing'].includes(status.toLowerCase());
  }

  private paymentStatus(status: string) {
    return ['paid', 'active', 'succeeded', 'success'].includes(status.toLowerCase())
      ? 'COMPLETED'
      : status.toUpperCase();
  }

  private planNameFromStatus(status: string) {
    return this.isActiveSubscriptionStatus(status) ? 'Premium' : 'Free';
  }
}
