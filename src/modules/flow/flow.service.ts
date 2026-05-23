import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import {
  applyVariables,
  renderFlowEmailShell,
  textToHtml,
} from './flow-email-template';
import { FlowMessage, FlowRecipient, FlowSendPayload } from './flow-email.types';

type ResendEmailPayload = {
  from: string;
  to: string[];
  subject: string;
  html: string;
  reply_to?: string;
  tags?: Array<{ name: string; value: string }>;
};

@Injectable()
export class FlowService {
  private readonly resendApiKey = process.env.RESEND_API_KEY;
  private readonly resendApiUrl = 'https://api.resend.com';

  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

  getConfig() {
    const senders = this.senderIdentities();
    const defaultFrom =
      process.env.FLOW_DEFAULT_FROM ||
      process.env.RESEND_FROM ||
      senders[0]?.email ||
      'Flow Mail <mail@flow.chefuinc.com>';

    return {
      defaultFrom,
      defaultReplyTo: process.env.FLOW_DEFAULT_REPLY_TO || '',
      inboundAddress: process.env.FLOW_INBOUND_ADDRESS || '',
      inboundConfigured: Boolean(process.env.FLOW_INBOUND_SECRET),
      maxRecipients: this.maxRecipients(),
      resendConfigured: Boolean(this.resendApiKey),
      senders,
    };
  }

  async getMessages(folder = 'inbox') {
    const normalizedFolder = this.normalizeFolder(folder);
    const snapshot = await this.messagesCollection()
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();
    const messages = snapshot.docs
      .map(doc => this.toMessage(doc.id, doc.data()))
      .filter(message => message.folder === normalizedFolder);

    return {
      folder: normalizedFolder,
      messages,
      counts: this.countFolders(snapshot.docs.map(doc => doc.data())),
    };
  }

  async send(payload: FlowSendPayload) {
    if (!this.resendApiKey) {
      throw new InternalServerErrorException('RESEND_API_KEY is not configured.');
    }

    const normalized = this.normalizePayload(payload);
    const limit = this.maxRecipients();
    const recipients =
      normalized.action === 'test'
        ? [
            {
              email: normalized.testEmail || normalized.recipients[0].email,
              firstName: 'Test',
              lastName: 'Recipient',
              company: 'Flow',
              tags: ['test'],
            },
          ]
        : normalized.recipients.slice(0, limit);

    if (
      normalized.action === 'campaign' &&
      normalized.recipients.length > limit
    ) {
      throw new BadRequestException(
        `Audience exceeds FLOW_MAX_RECIPIENTS (${limit}).`,
      );
    }

    const emails = recipients.map(recipient =>
      this.createResendEmail(normalized, recipient),
    );
    const response =
      emails.length === 1
        ? await this.postToResend('/emails', emails[0])
        : await this.postToResend('/emails/batch', emails, {
            'x-batch-validation': 'permissive',
          });
    const sentAt = new Date().toISOString();

    await this.messagesCollection().add({
      attachments: 0,
      createdAt: FieldValue.serverTimestamp(),
      direction: 'outbound',
      folder: 'sent',
      from: normalized.from,
      html: renderFlowEmailShell({
        body: textToHtml(normalized.html),
        ctaLabel: normalized.ctaLabel || undefined,
        ctaUrl: normalized.ctaUrl || undefined,
        preheader: normalized.preheader,
        title: normalized.subject,
      }),
      label: normalized.action === 'test' ? 'Test' : 'Campaign',
      preview: this.previewFromText(normalized.html),
      sentAt,
      starred: false,
      subject: normalized.subject,
      text: normalized.html,
      to: recipients.map(recipient => recipient.email),
      unread: false,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      action: normalized.action,
      audienceName: normalized.audienceName,
      count: emails.length,
      data: response,
      sentAt,
    };
  }

  async receiveInbound(payload: unknown) {
    const message = this.normalizeInbound(
      await this.enrichInboundPayload(payload),
    );
    const doc = await this.messagesCollection().add({
      ...message,
      attachments: message.attachments || 0,
      createdAt: FieldValue.serverTimestamp(),
      folder: 'inbox',
      direction: 'inbound',
      unread: true,
      starred: false,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      id: doc.id,
      received: true,
      receivedAt: message.receivedAt,
    };
  }

  private normalizePayload(payload: FlowSendPayload) {
    const action = payload.action || 'test';
    const recipients = Array.isArray(payload.recipients)
      ? payload.recipients.filter(recipient =>
          /^\S+@\S+\.\S+$/.test(String(recipient.email || '')),
        )
      : [];

    if (action !== 'test' && action !== 'campaign') {
      throw new BadRequestException('Invalid Flow send action.');
    }
    if (!payload.from || !payload.from.includes('@')) {
      throw new BadRequestException('A valid sender is required.');
    }
    if (!this.isAllowedSender(payload.from)) {
      throw new BadRequestException('Sender is not allowed for Flow Mail.');
    }
    if (!payload.subject || payload.subject.trim().length < 2) {
      throw new BadRequestException('Subject is required.');
    }
    if (!payload.html || payload.html.trim().length < 20) {
      throw new BadRequestException('Message body is required.');
    }
    if (!recipients.length && action === 'test' && payload.testEmail) {
      recipients.push({
        email: payload.testEmail,
        firstName: 'Test',
        lastName: 'Recipient',
        company: 'CheFu Inc',
        tags: ['test'],
      });
    }

    if (!recipients.length) {
      throw new BadRequestException('At least one valid recipient is required.');
    }

    return {
      action,
      audienceName: payload.audienceName || 'Manual audience',
      ctaLabel: payload.ctaLabel || '',
      ctaUrl: payload.ctaUrl || '',
      from: payload.from,
      html: payload.html,
      preheader: payload.preheader || '',
      recipients,
      replyTo: payload.replyTo || '',
      subject: payload.subject,
      tags: Array.isArray(payload.tags) ? payload.tags : [],
      testEmail: payload.testEmail || '',
    };
  }

  private createResendEmail(
    payload: ReturnType<FlowService['normalizePayload']>,
    recipient: FlowRecipient,
  ): ResendEmailPayload {
    const variables = {
      audienceName: payload.audienceName,
      company: recipient.company || 'CheFu Inc',
      email: recipient.email,
      firstName: recipient.firstName || recipient.email.split('@')[0],
      lastName: recipient.lastName || '',
    };
    const subject = applyVariables(payload.subject, variables);
    const body = applyVariables(payload.html, variables);

    return {
      from: payload.from,
      to: [recipient.email],
      subject,
      html: renderFlowEmailShell({
        body: textToHtml(body),
        ctaLabel: payload.ctaLabel || undefined,
        ctaUrl: payload.ctaUrl || undefined,
        preheader: payload.preheader,
        title: subject,
      }),
      reply_to: payload.replyTo || undefined,
      tags: [
        { name: 'app', value: 'flow' },
        { name: 'audience', value: payload.audienceName.slice(0, 40) },
        ...payload.tags.slice(0, 3).map(tag => ({
          name: 'tag',
          value: tag.slice(0, 40),
        })),
      ],
    };
  }

  private async postToResend(
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ) {
    const response = await fetch(`${this.resendApiUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.resendApiKey}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(async () => ({
      message: await response.text().catch(() => ''),
    }));

    if (!response.ok) {
      throw new InternalServerErrorException({
        error: 'Resend request failed.',
        details: data,
      });
    }

    return data;
  }

  private maxRecipients() {
    return Math.max(1, Number(process.env.FLOW_MAX_RECIPIENTS || 100));
  }

  private senderIdentities() {
    const raw =
      process.env.FLOW_SENDERS ||
      process.env.FLOW_DEFAULT_FROM ||
      process.env.RESEND_FROM ||
      '';

    return raw
      .split(';')
      .map(value => value.trim())
      .filter(Boolean)
      .map(value => ({
        label: this.senderLabel(value),
        email: value,
      }));
  }

  private isAllowedSender(sender: string) {
    const senders = this.senderIdentities();
    if (!senders.length) return true;

    return senders.some(
      identity => identity.email.toLowerCase() === sender.toLowerCase(),
    );
  }

  private senderLabel(sender: string) {
    const match = sender.match(/^(.+?)\s*<(.+?)>$/);
    if (!match) return sender;

    return `${match[1].replace(/^"|"$/g, '').trim()} (${match[2].trim()})`;
  }

  private messagesCollection() {
    return this.firebaseAdmin.db().collection('flowMessages');
  }

  private normalizeFolder(value?: string) {
    const folder = String(value || 'inbox').toLowerCase();
    if (
      ['inbox', 'sent', 'scheduled', 'campaigns', 'archived', 'trash'].includes(
        folder,
      )
    ) {
      return folder as FlowMessage['folder'];
    }

    return 'inbox';
  }

  private countFolders(messages: Array<Record<string, unknown>>) {
    const counts = {
      inbox: 0,
      sent: 0,
      scheduled: 0,
      campaigns: 0,
      archived: 0,
      trash: 0,
    };

    messages.forEach(message => {
      const folder = this.normalizeFolder(String(message.folder || 'inbox'));
      counts[folder] += 1;
    });

    return counts;
  }

  private toMessage(
    id: string,
    data: Record<string, unknown>,
  ): FlowMessage {
    return {
      id,
      attachments: Number(data.attachments) || 0,
      createdAt: this.timestampToIso(data.createdAt),
      direction: data.direction === 'outbound' ? 'outbound' : 'inbound',
      folder: this.normalizeFolder(String(data.folder || 'inbox')),
      from: String(data.from || ''),
      html: typeof data.html === 'string' ? data.html : undefined,
      label: typeof data.label === 'string' ? data.label : undefined,
      preview: String(data.preview || ''),
      receivedAt:
        typeof data.receivedAt === 'string'
          ? data.receivedAt
          : this.timestampToIso(data.receivedAt),
      sentAt:
        typeof data.sentAt === 'string'
          ? data.sentAt
          : this.timestampToIso(data.sentAt),
      starred: Boolean(data.starred),
      subject: String(data.subject || '(no subject)'),
      text: typeof data.text === 'string' ? data.text : undefined,
      to: Array.isArray(data.to) ? data.to.map(String) : [],
      unread: Boolean(data.unread),
    };
  }

  private normalizeInbound(payload: unknown) {
    const input =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {};
    const data =
      input.data && typeof input.data === 'object'
        ? (input.data as Record<string, unknown>)
        : input;
    const email =
      data.email && typeof data.email === 'object'
        ? (data.email as Record<string, unknown>)
        : data;
    const from = this.normalizeAddress(email.from || data.from || input.from);
    const to = this.normalizeAddressList(email.to || data.to || input.to);
    const subject = String(
      email.subject || data.subject || input.subject || '(no subject)',
    );
    const text = String(
      email.text || email.text_body || data.text || input.text || '',
    );
    const html =
      typeof email.html === 'string'
        ? email.html
        : typeof email.html_body === 'string'
          ? email.html_body
          : typeof data.html === 'string'
            ? data.html
            : undefined;
    const preview = this.previewFromText(
      text || this.stripHtml(html || '') || subject,
    );

    if (!from) {
      throw new BadRequestException('Inbound email sender is required.');
    }

    return {
      attachments: Array.isArray(email.attachments) ? email.attachments.length : 0,
      from,
      html,
      label: 'Inbound',
      preview,
      receivedAt: new Date().toISOString(),
      subject,
      text,
      to,
    };
  }

  private normalizeAddress(value: unknown) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const address = value as Record<string, unknown>;
      return String(address.email || address.address || address.text || '');
    }

    return '';
  }

  private normalizeAddressList(value: unknown) {
    if (Array.isArray(value)) {
      return value.map(item => this.normalizeAddress(item)).filter(Boolean);
    }
    const address = this.normalizeAddress(value);
    return address ? [address] : [];
  }

  private previewFromText(value: string) {
    return value.replace(/\s+/g, ' ').trim().slice(0, 180);
  }

  private async enrichInboundPayload(payload: unknown) {
    const input =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {};
    const data =
      input.data && typeof input.data === 'object'
        ? (input.data as Record<string, unknown>)
        : input;
    const emailId =
      typeof data.email_id === 'string'
        ? data.email_id
        : typeof data.id === 'string'
          ? data.id
          : '';

    if (!emailId || !this.resendApiKey) return payload;

    try {
      const email = await this.getFromResend(`/emails/receiving/${emailId}`);
      return {
        ...input,
        data: {
          ...data,
          ...(email && typeof email === 'object' ? email : {}),
        },
      };
    } catch {
      return payload;
    }
  }

  private async getFromResend(path: string) {
    const response = await fetch(`${this.resendApiUrl}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.resendApiKey}`,
      },
    });
    const data = await response.json().catch(async () => ({
      message: await response.text().catch(() => ''),
    }));

    if (!response.ok) {
      throw new InternalServerErrorException({
        error: 'Resend request failed.',
        details: data,
      });
    }

    return data;
  }

  private stripHtml(value: string) {
    return value.replace(/<[^>]+>/g, ' ');
  }

  private timestampToIso(value: unknown) {
    if (
      value &&
      typeof value === 'object' &&
      'toDate' in value &&
      typeof (value as { toDate?: unknown }).toDate === 'function'
    ) {
      return (value as { toDate: () => Date }).toDate().toISOString();
    }

    return undefined;
  }
}
