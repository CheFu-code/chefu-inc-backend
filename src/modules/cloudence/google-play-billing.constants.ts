export const GOOGLE_PLAY_PACKAGE_NAME = 'za.co.chefu.cloudence';
export const GOOGLE_PLAY_PRODUCT_IDS = [
  'cloudence_pro_monthly',
  'cloudence_storage_50gb_monthly',
] as const;

export type GooglePlayProductId = (typeof GOOGLE_PLAY_PRODUCT_IDS)[number];

export type GooglePlaySubscriptionPurchase = {
  subscriptionState?: string;
  acknowledgementState?: string;
  linkedPurchaseToken?: string | null;
  externalAccountIdentifiers?: {
    obfuscatedExternalAccountId?: string | null;
  } | null;
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;
  }>;
};

export type CloudenceSubscriptionRecord = {
  tokenHash: string;
  status: string;
  expiresAt: string;
};

export function isGooglePlayProductId(
  value: string,
): value is GooglePlayProductId {
  return (GOOGLE_PLAY_PRODUCT_IDS as readonly string[]).includes(value);
}

export function isSubscriptionStateEntitled(
  state: string | undefined,
): boolean {
  return (
    state === 'SUBSCRIPTION_STATE_ACTIVE' ||
    state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' ||
    state === 'SUBSCRIPTION_STATE_CANCELED'
  );
}
