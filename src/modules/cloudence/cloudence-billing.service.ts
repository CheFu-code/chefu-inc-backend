import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Transaction } from 'firebase-admin/firestore';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import {
  MAX_STORAGE_BYTES,
  MAX_SUBSCRIBED_STORAGE_BYTES,
  SUBSCRIPTION_COLLECTION,
  SUBSCRIPTION_TOKEN_COLLECTION,
} from './cloudence.constants';
import {
  CloudenceSubscriptionRecord,
  GOOGLE_PLAY_PRODUCT_IDS,
  GooglePlayProductId,
  GooglePlaySubscriptionPurchase,
  isGooglePlayProductId,
  isSubscriptionStateEntitled,
} from './google-play-billing.constants';
import { GooglePlayPublisherService } from './google-play-publisher.service';

type SubscriptionData = {
  subscriptions?: Partial<Record<GooglePlayProductId, CloudenceSubscriptionRecord>>;
};

type StorageEntitlement = {
  all: number;
  plan: 'free' | '50gb';
  expiresAt: string | null;
  productId: GooglePlayProductId | null;
};

@Injectable()
export class CloudenceBillingService {
  constructor(
    private readonly firebaseAdmin: FirebaseAdminService,
    private readonly googlePlay: GooglePlayPublisherService,
  ) {}

  status() {
    return {
      enabled: this.googlePlay.isConfigured(),
      productIds: GOOGLE_PLAY_PRODUCT_IDS,
    };
  }

  async verifyPurchase(userId: string, productId: string, purchaseToken: string) {
    if (!this.googlePlay.isConfigured()) {
      throw new ServiceUnavailableException(
        'Google Play billing is not configured.',
      );
    }
    if (!isGooglePlayProductId(productId)) {
      throw new BadRequestException('Unsupported Google Play product.');
    }
    const token = purchaseToken.trim();
    if (!token || token.length > 4096) {
      throw new BadRequestException('A valid Google Play purchase token is required.');
    }

    const purchase = await this.googlePlay.getSubscription(token);
    const subscription = this.toSubscriptionRecord(purchase, productId, token);
    if (
      !subscription ||
      !isSubscriptionStateEntitled(subscription.status) ||
      Date.parse(subscription.expiresAt) <= Date.now()
    ) {
      throw new BadRequestException(
        'Google Play does not report an active subscription for this product.',
      );
    }

    const appAccountId =
      purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId;
    if (!appAccountId || appAccountId !== this.obfuscatedUserId(userId)) {
      throw new ConflictException(
        'This Google Play purchase belongs to a different Cloudence account.',
      );
    }
    await this.assertTokenOwnership(
      userId,
      token,
      purchase.linkedPurchaseToken,
    );
    if (
      purchase.acknowledgementState !==
      'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'
    ) {
      await this.googlePlay.acknowledge(productId, token);
    }
    await this.savePurchase(
      userId,
      productId,
      subscription,
      token,
      purchase.linkedPurchaseToken,
    );
    return this.getEntitlement(userId);
  }

  async getEntitlement(
    userId: string,
    transaction?: Transaction,
  ): Promise<StorageEntitlement> {
    const db = this.firebaseAdmin.db();
    const ref = db.collection(SUBSCRIPTION_COLLECTION).doc(userId);
    const snapshot = transaction ? await transaction.get(ref) : await ref.get();
    return this.entitlementFromData(snapshot.data() as SubscriptionData | undefined);
  }

  async handleNotification(purchaseToken: string, revoked = false) {
    const token = purchaseToken.trim();
    if (!token || token.length > 4096) {
      throw new BadRequestException('A valid purchase token is required.');
    }
    const db = this.firebaseAdmin.db();
    const tokenHash = this.hashToken(token);
    const tokenRef = db.collection(SUBSCRIPTION_TOKEN_COLLECTION).doc(tokenHash);
    const tokenSnapshot = await tokenRef.get();
    const owner = tokenSnapshot.data() as
      | { userId?: string; productId?: GooglePlayProductId }
      | undefined;
    if (
      !owner?.userId ||
      !owner.productId ||
      !isGooglePlayProductId(owner.productId)
    ) {
      return { processed: false };
    }

    const subscriptionRef = db
      .collection(SUBSCRIPTION_COLLECTION)
      .doc(owner.userId);
    const subscriptionSnapshot = await subscriptionRef.get();
    const currentSubscription = (
      subscriptionSnapshot.data() as SubscriptionData | undefined
    )?.subscriptions?.[owner.productId];
    if (currentSubscription && currentSubscription.tokenHash !== tokenHash) {
      return { processed: true, stale: true };
    }

    if (revoked) {
      await this.savePurchase(
        owner.userId,
        owner.productId,
        {
          tokenHash,
          status: 'SUBSCRIPTION_STATE_EXPIRED',
          expiresAt: new Date().toISOString(),
        },
        token,
      );
      return { processed: true };
    }

    const purchase = await this.googlePlay.getSubscription(token);
    const subscription = this.toSubscriptionRecord(
      purchase,
      owner.productId,
      token,
    );
    if (!subscription) {
      throw new BadRequestException(
        'Google Play notification does not match the stored subscription.',
      );
    }
    await this.savePurchase(
      owner.userId,
      owner.productId,
      subscription,
      token,
      purchase.linkedPurchaseToken,
    );
    return { processed: true };
  }

  private toSubscriptionRecord(
    purchase: GooglePlaySubscriptionPurchase,
    productId: GooglePlayProductId,
    token: string,
  ): CloudenceSubscriptionRecord | null {
    const line = purchase.lineItems?.find(
      (item) => item.productId === productId,
    );
    const expiry = line?.expiryTime;
    if (
      !line ||
      !expiry ||
      !Number.isFinite(Date.parse(expiry)) ||
      !purchase.subscriptionState
    ) {
      return null;
    }
    return {
      tokenHash: this.hashToken(token),
      status: purchase.subscriptionState,
      expiresAt: new Date(expiry).toISOString(),
    };
  }

  private async savePurchase(
    userId: string,
    productId: GooglePlayProductId,
    subscription: CloudenceSubscriptionRecord,
    token: string,
    linkedPurchaseToken?: string | null,
  ) {
    const db = this.firebaseAdmin.db();
    const tokenHash = this.hashToken(token);
    const tokenRef = db.collection(SUBSCRIPTION_TOKEN_COLLECTION).doc(tokenHash);
    const subscriptionRef = db
      .collection(SUBSCRIPTION_COLLECTION)
      .doc(userId);
    const linkedHash = linkedPurchaseToken
      ? this.hashToken(linkedPurchaseToken)
      : null;
    const linkedRef = linkedHash
      ? db.collection(SUBSCRIPTION_TOKEN_COLLECTION).doc(linkedHash)
      : null;

    await db.runTransaction(async (transaction) => {
      const tokenSnapshot = await transaction.get(tokenRef);
      const linkedSnapshot = linkedRef
        ? await transaction.get(linkedRef)
        : null;
      const currentSnapshot = await transaction.get(subscriptionRef);
      const tokenOwner = tokenSnapshot.data() as { userId?: string } | undefined;
      const linkedOwner = linkedSnapshot?.data() as
        | { userId?: string }
        | undefined;
      if (tokenOwner?.userId && tokenOwner.userId !== userId) {
        throw new ConflictException(
          'This Google Play purchase is already linked to another account.',
        );
      }
      if (linkedOwner?.userId && linkedOwner.userId !== userId) {
        throw new ConflictException(
          'This Google Play purchase is linked to another account.',
        );
      }

      const current = currentSnapshot.data() as SubscriptionData | undefined;
      transaction.set(
        subscriptionRef,
        {
          subscriptions: {
            ...current?.subscriptions,
            [productId]: subscription,
          },
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
      transaction.set(tokenRef, { userId, productId }, { merge: true });
    });
  }

  private entitlementFromData(
    data: SubscriptionData | undefined,
  ): StorageEntitlement {
    const now = Date.now();
    const active = GOOGLE_PLAY_PRODUCT_IDS.map((productId) => ({
      productId,
      subscription: data?.subscriptions?.[productId],
    }))
      .filter(
        (
          item,
        ): item is {
          productId: GooglePlayProductId;
          subscription: CloudenceSubscriptionRecord;
        } =>
          !!item.subscription &&
          isSubscriptionStateEntitled(item.subscription.status) &&
          Date.parse(item.subscription.expiresAt) > now,
      )
      .sort(
        (left, right) =>
          Date.parse(right.subscription.expiresAt) -
          Date.parse(left.subscription.expiresAt),
      )[0];
    return active
      ? {
          all: MAX_SUBSCRIBED_STORAGE_BYTES,
          plan: '50gb',
          expiresAt: active.subscription.expiresAt,
          productId: active.productId,
        }
      : {
          all: MAX_STORAGE_BYTES,
          plan: 'free',
          expiresAt: null,
          productId: null,
        };
  }

  private async assertTokenOwnership(
    userId: string,
    token: string,
    linkedPurchaseToken?: string | null,
  ) {
    const tokens = this.firebaseAdmin
        .db()
        .collection(SUBSCRIPTION_TOKEN_COLLECTION);
    const refs = [
        tokens.doc(this.hashToken(token)),
        ...(linkedPurchaseToken
          ? [tokens.doc(this.hashToken(linkedPurchaseToken))]
          : []),
    ];
    const snapshots = await Promise.all(refs.map((ref) => ref.get()));
    if (
        snapshots.some((snapshot) => {
          const owner = snapshot.data() as { userId?: string } | undefined;
          return owner?.userId && owner.userId !== userId;
        })
    ) {
        throw new ConflictException(
          'This Google Play purchase is already linked to another account.',
        );
    }
  }

  private obfuscatedUserId(userId: string) {
    return createHash('sha256').update(userId).digest('hex');
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
}
