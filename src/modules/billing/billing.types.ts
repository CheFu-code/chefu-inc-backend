export type BillingUser = {
  uid: string;
  email: string;
  roles: string[];
};

export type ClerkWebhookEvent = {
  data?: Record<string, unknown>;
  object?: string;
  timestamp?: number;
  type?: string;
};

export type NormalizedBillingStatus = {
  amount?: string;
  checkoutId?: string;
  currency?: string;
  customerId?: string;
  email?: string;
  externalUserId?: string;
  paidAt?: Date;
  payerName?: {
    given_name: string;
    surname: string;
  };
  periodEnd?: Date;
  planId?: string;
  planName?: string;
  status?: string;
  subscriptionId?: string;
};

export type BillingHistoryItem = {
  amount: {
    currency_code: string;
    value: string;
  };
  email: string;
  orderID: string;
  payerID: string;
  payerName: {
    given_name: string;
    surname: string;
  };
  planType: string;
  status: string;
  timestamp: string;
};

export type BillingStatusResponse = {
  billing: {
    customerId: string | null;
    member: boolean;
    memberUntil: string | null;
    planId: string | null;
    planName: string;
    provider: string;
    status: string;
    subscriptionId: string | null;
    updatedAt: string | null;
  };
  history: BillingHistoryItem[];
};
