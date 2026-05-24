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

export type FlowMessage = {
  id: string;
  folder: 'inbox' | 'sent' | 'scheduled' | 'campaigns' | 'archived' | 'trash';
  direction: 'inbound' | 'outbound';
  from: string;
  to: string[];
  subject: string;
  preview: string;
  text?: string;
  html?: string;
  label?: string;
  messageId?: string;
  resendEmailId?: string;
  unread: boolean;
  starred: boolean;
  attachments: number;
  receivedAt?: string;
  sentAt?: string;
  createdAt?: string;
};
