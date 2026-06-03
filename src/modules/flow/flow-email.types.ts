export type FlowRecipient = {
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  tags?: string[];
};

export type FlowSendPayload = {
  action?: 'test' | 'campaign';
  attachments?: FlowSendAttachment[];
  audienceName?: string;
  bodyFormat?: 'text' | 'html';
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

export type FlowSendAttachment = {
  content: string;
  contentId?: string;
  contentType?: string;
  filename: string;
  size?: number;
};

export type FlowMessage = {
  id: string;
  folder:
    | 'inbox'
    | 'sent'
    | 'drafts'
    | 'scheduled'
    | 'campaigns'
    | 'archived'
    | 'trash';
  direction: 'inbound' | 'outbound';
  from: string;
  to: string[];
  subject: string;
  preview: string;
  text?: string;
  html?: string;
  isReaction?: boolean;
  label?: string;
  inReplyTo?: string;
  messageId?: string;
  reactionCount?: number;
  reactionEmoji?: string;
  reactionFrom?: string;
  references?: string[];
  resendEmailId?: string;
  threadKey?: string;
  clickedAt?: string;
  clickCount?: number;
  deliveredAt?: string;
  deliveryStatus?: string;
  firstOpenedAt?: string;
  openCount?: number;
  openedAt?: string;
  unread: boolean;
  starred: boolean;
  attachments: number;
  attachmentItems?: FlowAttachment[];
  receivedAt?: string;
  sentAt?: string;
  createdAt?: string;
};

export type FlowAttachment = {
  id: string;
  filename: string;
  contentType?: string;
  contentDisposition?: string | null;
  contentId?: string | null;
  size?: number;
};
