export type FlowRecipient = {
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  tags?: string[];
};

export type FlowSendPayload = {
  action?: 'test' | 'campaign';
  audienceName?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  from?: string;
  html?: string;
  preheader?: string;
  recipients?: FlowRecipient[];
  replyTo?: string;
  subject?: string;
  tags?: string[];
  testEmail?: string;
};

