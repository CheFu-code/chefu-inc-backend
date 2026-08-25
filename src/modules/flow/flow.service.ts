import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import {
  applyVariables,
  createFlowTemplateVariables,
  renderFlowEmailShell,
  sanitizeFlowHtml,
  textToHtml,
} from './flow-email-template';
import {
  FlowAttachment,
  FlowMessage,
  FlowRecipient,
  FlowSendPayload,
} from './flow-email.types';
import {
  flowEnvAllowedEmails,
  formatSenderIdentity,
  isChefuEmail,
  normalizeEmailAddress,
  parseSenderLabel,
} from './flow-access';

type ResendEmailPayload = {
  attachments?: ResendAttachmentPayload[];
  from: string;
  reply_to?: string;
  html?: string;
  subject: string;
  tags?: Array<{ name: string; value: string }>;
  template?: {
    id: string;
    variables: Record<string, string>;
  };
  to: string[];
};

type ResendAttachmentPayload = {
  content: string;
  contentId?: string;
  content_type?: string;
  filename: string;
};

type NormalizedFlowPayload = {
  action: 'test' | 'campaign';
  audienceName: string;
  ctaLabel: string;
  ctaUrl: string;
  attachments: ResendAttachmentPayload[];
  bodyFormat: 'html' | 'text';
  from: string;
  html: string;
  preheader: string;
  recipients: FlowRecipient[];
  replyTo: string;
  subject: string;
  tags: string[];
  testEmail: string;
};

type FlowFolderCounts = {
  allmail: number;
  archived: number;
  campaigns: number;
  drafts: number;
  inbox: number;
  scheduled: number;
  sent: number;
  starred: number;
  trash: number;
};

@Injectable()
export class FlowService {
  private readonly logger = new Logger(FlowService.name);
  private readonly resendApiUrl = 'https://api.resend.com';

  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebaseAdmin: FirebaseAdminService,
  ) { }

  private get resendApiKey() {
    return process.env.RESEND_API_KEY;
  }

  async getConfig() {
    const senders = await this.senderIdentities();
    const configuredDefault =
      process.env.FLOW_DEFAULT_FROM || process.env.RESEND_FROM || '';
    const defaultFrom = this.isConfiguredSender(configuredDefault, senders)
      ? configuredDefault
      : senders[0]?.email ||
      configuredDefault ||
      'Flow Mail <mail@chefu.co.za>';

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
    const requestedFolder = String(folder || 'inbox').toLowerCase();
    const snapshot = await this.messagesCollection()
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();
    const allMessages = snapshot.docs.map(doc =>
      this.toMessage(doc.id, doc.data()),
    );
    const messages = this.filterMessagesByFolder(allMessages, requestedFolder);

    return {
      folder: requestedFolder,
      messages,
      counts: this.countFolders(allMessages),
    };
  }

  watchMessages(
    folder = 'inbox',
    onMessages: (payload: {
      counts: FlowFolderCounts;
      folder: string;
      messages: FlowMessage[];
      updatedAt: string;
    }) => void,
    onError: (error: Error) => void,
  ) {
    const requestedFolder = String(folder || 'inbox').toLowerCase();

    return this.messagesCollection()
      .orderBy('createdAt', 'desc')
      .limit(100)
      .onSnapshot(snapshot => {
        const allMessages = snapshot.docs.map(doc =>
          this.toMessage(doc.id, doc.data()),
        );

        onMessages({
          counts: this.countFolders(allMessages),
          folder: requestedFolder,
          messages: this.filterMessagesByFolder(allMessages, requestedFolder),
          updatedAt: new Date().toISOString(),
        });
      }, onError);
  }

  async send(payload: FlowSendPayload) {
    if (!this.resendApiKey) {
      throw new InternalServerErrorException('RESEND_API_KEY is not configured.');
    }

    const normalized = await this.normalizePayload(payload);
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

    const renderedEmails = recipients
      .map(recipient => ({
        body: this.renderRecipientBody(normalized, recipient),
        recipient,
        subject: this.renderRecipientSubject(normalized, recipient),
      }))
      .map(item => ({
        ...item,
        email: this.createResendEmail(
          normalized,
          item.recipient,
          item.body,
          item.subject,
        ),
        html: this.renderRecipientHtml(
          normalized,
          item.recipient,
          item.body,
          item.subject,
        ),
      }));
    const emails = renderedEmails.map(item => item.email);
    const response =
      emails.length === 1
        ? await this.postToResend('/emails', emails[0])
        : normalized.attachments.length
          ? await Promise.all(
            emails.map(email => this.postToResend('/emails', email)),
          )
          : await this.postToResend('/emails/batch', emails, {
            'x-batch-validation': 'permissive',
          });
    const sentAt = new Date().toISOString();
    const sendGroupId = randomUUID();

    await Promise.all(
      renderedEmails.map(({ body, email, html, recipient, subject }, index) =>
        this.messagesCollection().add({
          attachments: normalized.attachments.length,
          clickCount: 0,
          createdAt: FieldValue.serverTimestamp(),
          deliveryStatus: 'sent',
          direction: 'outbound',
          folder: 'sent',
          from: normalized.from,
          html,
          label: normalized.action === 'test' ? 'Test' : 'Sent',
          preview: this.previewForBody(body, normalized.bodyFormat),
          resendEmailId: this.sentEmailId(response, index),
          sendGroupId,
          sentAt,
          openCount: 0,
          starred: false,
          subject,
          text: this.textForBody(body, normalized.bodyFormat),
          threadKey: this.threadKeyForMessage(subject, normalized.from, [
            recipient.email,
          ]),
          to: [recipient.email],
          unread: false,
          updatedAt: FieldValue.serverTimestamp(),
        }),
      ),
    );

    return {
      action: normalized.action,
      audienceName: normalized.audienceName,
      count: emails.length,
      data: response,
      sentAt,
    };
  }

  async receiveInbound(payload: unknown) {
    const eventType = this.webhookEventType(payload);

    if (eventType && this.isEmailTrackingEvent(eventType)) {
      return this.trackEmailEvent(payload, eventType);
    }

    if (eventType && !this.isInboundEmailEvent(eventType)) {
      this.logger.log(
        JSON.stringify({
          event: 'flow_inbound_event_ignored',
          eventType,
        }),
      );

      return {
        eventType,
        ignored: true,
        received: false,
      };
    }

    const message = this.normalizeInbound(
      await this.enrichInboundPayload(payload),
    );
    const inboundData = this.withoutUndefined(message);
    const isInternalSender = this.isInternalSender(message.from);
    const folder: FlowMessage['folder'] = isInternalSender
      ? 'archived'
      : 'inbox';

    try {
      const existingId = await this.findExistingInboundMessage(message);
      if (existingId) {
        return {
          id: existingId,
          deduped: true,
          received: true,
          receivedAt: message.receivedAt,
          folder,
        };
      }

      const doc = await this.messagesCollection().add({
        ...inboundData,
        attachments: message.attachments || 0,
        createdAt: FieldValue.serverTimestamp(),
        folder,
        direction: 'inbound',
        label: isInternalSender ? 'Internal' : message.label,
        unread: !isInternalSender && !message.isReaction,
        starred: false,
        webhookEventType: eventType || 'manual',
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        id: doc.id,
        received: true,
        receivedAt: message.receivedAt,
        folder,
      };
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'flow_inbound_store_failed',
          reason: error instanceof Error ? error.message : 'unknown',
          from: message.from || null,
          toCount: message.to.length,
          subject: message.subject || null,
          messageId: message.messageId || null,
          resendEmailId: message.resendEmailId || null,
          attachments: message.attachments || 0,
          hasHtml: Boolean(message.html),
          hasText: Boolean(message.text),
        }),
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  async getAttachment(messageId: string, attachmentId: string) {
    const snapshot = await this.messagesCollection().doc(messageId).get();

    if (!snapshot.exists) {
      throw new BadRequestException('Message not found.');
    }

    const message = snapshot.data() || {};
    const resendEmailId =
      typeof message.resendEmailId === 'string'
        ? message.resendEmailId
        : typeof message.email_id === 'string'
          ? message.email_id
          : '';
    const attachmentItems = this.normalizeAttachments(message.attachmentItems);
    const attachment = attachmentItems.find(item => item.id === attachmentId);

    if (!resendEmailId || !attachment) {
      throw new BadRequestException('Attachment is not available.');
    }

    if (!this.resendApiKey) {
      throw new InternalServerErrorException('RESEND_API_KEY is not configured.');
    }

    const response = await fetch(
      `${this.resendApiUrl}/emails/receiving/${resendEmailId}/attachments/${attachmentId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.resendApiKey}`,
        },
      },
    );
    const data = await response.json().catch(async () => ({
      message: await response.text().catch(() => ''),
    }));

    if (!response.ok) {
      throw new InternalServerErrorException({
        error: 'Resend attachment request failed.',
        details: data,
      });
    }

    return {
      ...attachment,
      downloadUrl:
        data && typeof data === 'object'
          ? String((data as Record<string, unknown>).download_url || '')
          : '',
      expiresAt:
        data && typeof data === 'object'
          ? String((data as Record<string, unknown>).expires_at || '')
          : '',
    };
  }

  async listAttachments(messageId: string) {
    const ref = this.messagesCollection().doc(messageId);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      throw new BadRequestException('Message not found.');
    }

    const message = snapshot.data() || {};
    if (this.isGmailReactionStoredMessage(message)) {
      return { attachments: [] };
    }

    const storedAttachments = this.normalizeAttachments(message.attachmentItems);
    if (storedAttachments.length) {
      return { attachments: storedAttachments };
    }

    const resendEmailId =
      typeof message.resendEmailId === 'string'
        ? message.resendEmailId
        : typeof message.email_id === 'string'
          ? message.email_id
          : '';

    if (!resendEmailId) {
      return { attachments: [] };
    }

    if (!this.resendApiKey) {
      throw new InternalServerErrorException('RESEND_API_KEY is not configured.');
    }

    const response = await fetch(
      `${this.resendApiUrl}/emails/receiving/${resendEmailId}/attachments`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.resendApiKey}`,
        },
      },
    );
    const data = await response.json().catch(async () => ({
      message: await response.text().catch(() => ''),
    }));

    if (!response.ok) {
      this.logger.warn(
        `Resend attachment list failed for email_id=${resendEmailId}: ${JSON.stringify(
          data,
        )}`,
      );
      return { attachments: [] };
    }

    const rawAttachments =
      data && typeof data === 'object'
        ? (data as { data?: unknown; attachments?: unknown }).data ||
        (data as { attachments?: unknown }).attachments ||
        data
        : data;
    const attachments = this.normalizeAttachments(rawAttachments);

    if (attachments.length) {
      await ref.update({
        attachmentItems: attachments,
        attachments: attachments.length,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    return { attachments };
  }

  async markRead(messageId: string) {
    const ref = this.messagesCollection().doc(messageId);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      throw new BadRequestException('Message not found.');
    }

    await ref.update({
      unread: false,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      id: messageId,
      unread: false,
    };
  }

  async markUnread(messageId: string) {
    const ref = this.messagesCollection().doc(messageId);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      throw new BadRequestException('Message not found.');
    }

    await ref.update({
      unread: true,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      id: messageId,
      unread: true,
    };
  }

  async setStarred(messageId: string, starred: boolean) {
    const ref = this.messagesCollection().doc(messageId);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      throw new BadRequestException('Message not found.');
    }

    await ref.update({
      starred,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      id: messageId,
      starred,
    };
  }

  async moveToFolder(messageId: string, folder: string) {
    const normalizedFolder = this.normalizeMutableFolder(folder);
    const ref = this.messagesCollection().doc(messageId);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      throw new BadRequestException('Message not found.');
    }

    await ref.update({
      folder: normalizedFolder,
      unread: false,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      folder: normalizedFolder,
      id: messageId,
    };
  }

  async reportMessage(messageId: string) {
    const ref = this.messagesCollection().doc(messageId);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      throw new BadRequestException('Message not found.');
    }

    await ref.update({
      folder: 'archived',
      reportedSpam: true,
      unread: false,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      folder: 'archived',
      id: messageId,
      reportedSpam: true,
    };
  }

  async moveToTrash(messageId: string) {
    const ref = this.messagesCollection().doc(messageId);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      throw new BadRequestException('Message not found.');
    }

    await ref.update({
      folder: 'trash',
      unread: false,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      folder: 'trash',
      id: messageId,
    };
  }

  async deleteMessage(messageId: string) {
    const ref = this.messagesCollection().doc(messageId);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      throw new BadRequestException('Message not found.');
    }

    await ref.delete();

    return {
      deleted: true,
      id: messageId,
    };
  }

  async saveDraft(payload: {
    body?: string;
    from?: string;
    subject?: string;
    to?: string | string[];
  }) {
    const body = String(payload.body || '').trim();
    const subject = String(payload.subject || '(no subject)').trim() || '(no subject)';
    const config = await this.getConfig();
    const resolvedFrom = await this.resolveSender(payload.from || '');
    const from =
      resolvedFrom ||
      config.defaultFrom ||
      'Flow Mail <mail@flow.chefu.co.za>';
    const to = this.normalizeAddressList(payload.to).filter(address =>
      /^\S+@\S+\.\S+$/.test(this.emailAddress(address) || address),
    );

    if (!body && subject === '(no subject)' && !to.length) {
      throw new BadRequestException('Draft is empty.');
    }

    const now = new Date().toISOString();
    const doc = await this.messagesCollection().add({
      attachments: 0,
      createdAt: FieldValue.serverTimestamp(),
      direction: 'outbound',
      folder: 'drafts',
      from,
      preview: this.previewFromText(body),
      sentAt: now,
      starred: false,
      subject,
      text: body,
      threadKey: this.threadKeyForMessage(subject, from, to),
      to,
      unread: false,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      draft: this.toMessage(doc.id, {
        attachments: 0,
        createdAt: new Date(),
        direction: 'outbound',
        folder: 'drafts',
        from,
        preview: this.previewFromText(body),
        sentAt: now,
        starred: false,
        subject,
        text: body,
        threadKey: this.threadKeyForMessage(subject, from, to),
        to,
        unread: false,
      }),
      saved: true,
    };
  }

  // ── Allowed email & sender management ──────────────────────────────────

  /**
   * Returns true when the given email is permitted to access Flow Mail.
   * Checks both the env FLOW_SENDERS list and the Firestore allowed-emails
   * collection. When FLOW_SENDERS is empty (open access), returns true.
   */
  async isAllowedFlowUser(email?: string | null) {
    const normalized = normalizeEmailAddress(email || '');
    if (!normalized) return false;

    // Fast path: env senders list (synchronous)
    const envEmails = flowEnvAllowedEmails();
    if (envEmails.has(normalized)) return true;

    // Check Firestore allowed-emails collection
    try {
      const doc = await this.allowedEmailsCollection().doc(this.emailDocId(normalized)).get();
      if (doc.exists && String((doc.data() || {}).status || '') === 'active') {
        return true;
      }
    } catch {
      // Ignore Firestore lookup failures and fall through to fallback
    }

    if (!envEmails.size) return true; // open access fallback
    return false;
  }

  /** Returns all registered senders (env + Firestore) and allowed email records. */
  async listAllowedEmails() {
    const senders = await this.senderIdentities();
    const snapshot = await this.allowedEmailsCollection()
      .where('status', '==', 'active')
      .get();

    const emails = snapshot.docs.map(doc => {
      const data = doc.data() || {};
      return {
        addedAt: this.firestoreTimestampToIso(data.addedAt),
        addedBy: typeof data.addedBy === 'string' ? data.addedBy : null,
        email: String(data.email || doc.id),
        formattedEmail: typeof data.formattedEmail === 'string' ? data.formattedEmail : undefined,
        label: typeof data.label === 'string' ? data.label : undefined,
        name: typeof data.name === 'string' ? data.name : undefined,
      };
    });

    return {
      emails,
      senders,
    };
  }

  /**
   * Adds a new allowed email / sender to the Firestore collection.
   * Only `@chefu.co.za` addresses are accepted.
   */
  async addAllowedEmail(
    email: string,
    name?: string | null,
    addedBy?: string | null,
  ) {
    const normalized = normalizeEmailAddress(email);

    if (!normalized) {
      throw new BadRequestException('A valid email address is required.');
    }
    if (!isChefuEmail(normalized)) {
      throw new BadRequestException(
        'Only @chefu.co.za email addresses may be added as Flow Mail senders.',
      );
    }

    const cleanName = (name || '').trim().replace(/[<>"\r\n]/g, '');
    const formattedEmail = formatSenderIdentity(normalized, cleanName);
    const label = parseSenderLabel(formattedEmail);
    const docId = this.emailDocId(normalized);
    const ref = this.allowedEmailsCollection().doc(docId);
    const existing = await ref.get();

    if (existing.exists && String((existing.data() || {}).status || '') === 'active') {
      await ref.update({
        formattedEmail,
        label,
        name: cleanName || null,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        added: true,
        email: normalized,
        label,
        message: 'Sender identity updated.',
        name: cleanName || undefined,
        sender: {
          addedAt: this.firestoreTimestampToIso((existing.data() || {}).addedAt) || new Date().toISOString(),
          email: formattedEmail,
          label,
          name: cleanName || undefined,
          source: 'custom' as const,
        },
      };
    }

    const nowIso = new Date().toISOString();
    await ref.set({
      addedAt: FieldValue.serverTimestamp(),
      addedBy: addedBy || null,
      email: normalized,
      formattedEmail,
      label,
      name: cleanName || null,
      removedAt: null,
      status: 'active',
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      added: true,
      email: normalized,
      label,
      name: cleanName || undefined,
      sender: {
        addedAt: nowIso,
        email: formattedEmail,
        label,
        name: cleanName || undefined,
        source: 'custom' as const,
      },
    };
  }

  /**
   * Soft-removes an email from the allowed-emails collection.
   */
  async removeAllowedEmail(email: string) {
    const normalized = normalizeEmailAddress(email);

    if (!normalized) {
      throw new BadRequestException('A valid email address is required.');
    }

    const ref = this.allowedEmailsCollection().doc(this.emailDocId(normalized));
    const existing = await ref.get();

    if (!existing.exists || String((existing.data() || {}).status || '') !== 'active') {
      throw new BadRequestException('Email is not an active custom Flow Mail sender.');
    }

    await ref.update({
      removedAt: FieldValue.serverTimestamp(),
      status: 'removed',
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      email: normalized,
      removed: true,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async normalizePayload(payload: FlowSendPayload) {
    const action = payload.action || 'test';
    const recipients = Array.isArray(payload.recipients)
      ? payload.recipients.filter(recipient =>
        /^\S+@\S+\.\S+$/.test(String(recipient.email || '')),
      )
      : [];
    const attachments = this.normalizeSendAttachments(payload.attachments);
    const bodyFormat: 'html' | 'text' =
      payload.bodyFormat === 'html' ? 'html' : 'text';

    if (action !== 'test' && action !== 'campaign') {
      throw new BadRequestException('Invalid Flow send action.');
    }
    const from = await this.resolveSender(payload.from || '');

    if (!from) {
      throw new BadRequestException('A valid sender is required.');
    }
    if (!(await this.isAllowedSender(from))) {
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
        company: 'CHEFU Inc',
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
      attachments,
      bodyFormat,
      from,
      html: payload.html,
      preheader: payload.preheader || '',
      recipients,
      replyTo: payload.replyTo || '',
      subject: payload.subject,
      tags: Array.isArray(payload.tags) ? payload.tags : [],
      testEmail: payload.testEmail || '',
    };
  }

  private normalizeSendAttachments(
    attachments: FlowSendPayload['attachments'],
  ): ResendAttachmentPayload[] {
    if (!Array.isArray(attachments)) return [];

    const normalized = attachments
      .map(attachment => {
        const filename = String(attachment.filename || '').trim();
        const content = String(attachment.content || '').trim();

        if (!filename || !content) return null;

        const item: ResendAttachmentPayload = {
          content,
          filename,
        };
        const contentId = String(attachment.contentId || '').trim();
        const contentType = String(attachment.contentType || '').trim();

        if (contentId) item.contentId = contentId.slice(0, 127);
        if (contentType) item.content_type = contentType;

        return item;
      })
      .filter((item): item is ResendAttachmentPayload => Boolean(item));

    const encodedSize = normalized.reduce(
      (total, attachment) => total + attachment.content.length,
      0,
    );

    if (encodedSize > 34 * 1024 * 1024) {
      throw new BadRequestException(
        'Attachments are too large. Keep total files under 24 MB before encoding.',
      );
    }

    return normalized;
  }

  private htmlForBody(body: string, format: 'html' | 'text') {
    return format === 'html' ? sanitizeFlowHtml(body) : textToHtml(body);
  }

  private textForBody(body: string, format: 'html' | 'text') {
    return format === 'html' ? this.stripHtml(body) : body;
  }

  private previewForBody(body: string, format: 'html' | 'text') {
    return this.previewFromText(this.textForBody(body, format));
  }

  private createResendEmail(
    payload: NormalizedFlowPayload,
    recipient: FlowRecipient,
    body: string,
    subject: string,
  ): ResendEmailPayload {
    const bodyHtml = this.htmlForBody(body, payload.bodyFormat);
    const emailTemplateId = this.flowEmailTemplateId();
    const baseEmail = {
      attachments: payload.attachments.length
        ? payload.attachments
        : undefined,
      from: payload.from,
      to: [recipient.email],
      subject,
      reply_to: payload.replyTo || undefined,
      tags: [
        { name: 'app', value: 'flow' },
        {
          name: 'audience',
          value: this.resendTagValue(payload.audienceName, 'manual_audience'),
        },
        ...payload.tags.slice(0, 3).map(tag => ({
          name: 'tag',
          value: this.resendTagValue(tag, 'flow'),
        })),
      ],
    };

    if (emailTemplateId) {
      const templatePayload = createFlowTemplateVariables({
        audienceName: payload.audienceName,
        bodyHtml,
        ctaLabel: payload.ctaLabel || undefined,
        ctaUrl: payload.ctaUrl || undefined,
        preheader: payload.preheader || this.previewFromText(body),
        recipientName: this.recipientDisplayName(recipient),
        senderName: this.senderDisplayName(payload.from),
        title: subject,
      });

      if (templatePayload.fitsResendTemplateLimits) {
        return {
          ...baseEmail,
          template: {
            id: emailTemplateId,
            variables: templatePayload.variables,
          },
        };
      }

      this.logger.warn(
        JSON.stringify({
          event: 'flow_template_payload_too_large',
          recipient: recipient.email,
          templateId: emailTemplateId,
        }),
      );
    }

    return {
      ...baseEmail,
      html: this.renderRecipientHtml(payload, recipient, body, subject),
    };
  }

  private renderRecipientBody(
    payload: NormalizedFlowPayload,
    recipient: FlowRecipient,
  ) {
    return applyVariables(payload.html, this.recipientVariables(payload, recipient));
  }

  private renderRecipientSubject(
    payload: NormalizedFlowPayload,
    recipient: FlowRecipient,
  ) {
    return applyVariables(
      payload.subject,
      this.recipientVariables(payload, recipient),
    );
  }

  private renderRecipientHtml(
    payload: NormalizedFlowPayload,
    recipient: FlowRecipient,
    body: string,
    subject: string,
  ) {
    return renderFlowEmailShell({
      audienceName: payload.audienceName,
      body: this.htmlForBody(body, payload.bodyFormat),
      ctaLabel: payload.ctaLabel || undefined,
      ctaUrl: payload.ctaUrl || undefined,
      preheader: payload.preheader || this.previewForBody(body, payload.bodyFormat),
      recipientName: this.recipientDisplayName(recipient),
      senderName: this.senderDisplayName(payload.from),
      title: subject,
    });
  }

  private recipientVariables(
    payload: NormalizedFlowPayload,
    recipient: FlowRecipient,
  ) {
    return {
      audienceName: payload.audienceName,
      company: recipient.company || 'CHEFU Inc',
      email: recipient.email,
      firstName: recipient.firstName || recipient.email.split('@')[0],
      lastName: recipient.lastName || '',
    };
  }

  private sentEmailId(response: unknown, index: number) {
    if (!response || typeof response !== 'object') return undefined;

    const payload = response as Record<string, unknown>;
    if (index === 0 && typeof payload.id === 'string') return payload.id;

    const data = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.emails)
        ? payload.emails
        : Array.isArray(response)
          ? response
          : [];
    const item = data[index];

    if (item && typeof item === 'object') {
      const email = item as Record<string, unknown>;
      if (typeof email.id === 'string') return email.id;
      if (typeof email.email_id === 'string') return email.email_id;
    }

    return undefined;
  }

  private webhookEventType(payload: unknown) {
    if (!payload || typeof payload !== 'object') return '';

    const input = payload as Record<string, unknown>;
    const data =
      input.data && typeof input.data === 'object'
        ? (input.data as Record<string, unknown>)
        : {};

    return String(
      input.type ||
      input.event ||
      input.eventType ||
      data.type ||
      data.event ||
      data.eventType ||
      '',
    )
      .trim()
      .toLowerCase();
  }

  private isInboundEmailEvent(eventType: string) {
    return [
      'email.received',
      'email.inbound',
      'email.delivered_to_inbox',
      'inbound.email.received',
    ].includes(eventType);
  }

  private isEmailTrackingEvent(eventType: string) {
    return [
      'email.opened',
      'email.clicked',
      'email.delivered',
      'email.delivery_delayed',
      'email.bounced',
      'email.complained',
      'email.failed',
      'email.sent',
    ].includes(eventType);
  }

  private async trackEmailEvent(payload: unknown, eventType: string) {
    const event = this.emailTrackingEvent(payload);

    if (!event.emailId) {
      return {
        eventType,
        ignored: true,
        reason: 'missing_email_id',
        tracked: false,
      };
    }

    const snapshot = await this.messagesCollection()
      .where('resendEmailId', '==', event.emailId)
      .limit(10)
      .get();

    if (snapshot.empty) {
      this.logger.log(
        JSON.stringify({
          event: 'flow_email_tracking_unmatched',
          emailId: event.emailId,
          eventType,
        }),
      );

      return {
        emailId: event.emailId,
        eventType,
        tracked: false,
      };
    }

    const batch = this.firebaseAdmin.db().batch();

    snapshot.docs.forEach(doc => {
      batch.update(
        doc.ref,
        this.withoutUndefined({
          ...this.trackingUpdateForEvent(eventType, event.createdAt, doc.data()),
          lastTrackingEvent: eventType,
          lastTrackingEventAt: event.createdAt,
          updatedAt: FieldValue.serverTimestamp(),
        }),
      );
    });

    await batch.commit();

    return {
      count: snapshot.size,
      emailId: event.emailId,
      eventType,
      tracked: true,
    };
  }

  private emailTrackingEvent(payload: unknown) {
    const input =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {};
    const data =
      input.data && typeof input.data === 'object'
        ? (input.data as Record<string, unknown>)
        : input;
    const createdAt = String(
      input.created_at || input.createdAt || data.created_at || new Date().toISOString(),
    );

    return {
      createdAt,
      emailId: String(data.email_id || data.emailId || input.email_id || ''),
    };
  }

  private trackingUpdateForEvent(
    eventType: string,
    createdAt: string,
    current: Record<string, unknown>,
  ) {
    if (eventType === 'email.opened') {
      return {
        deliveryStatus: 'opened',
        firstOpenedAt: current.firstOpenedAt ? undefined : createdAt,
        openCount: FieldValue.increment(1),
        openedAt: createdAt,
      };
    }

    if (eventType === 'email.clicked') {
      return {
        clickCount: FieldValue.increment(1),
        clickedAt: createdAt,
        deliveryStatus: 'clicked',
        firstOpenedAt: current.firstOpenedAt ? undefined : createdAt,
        openedAt: current.openedAt ? undefined : createdAt,
      };
    }

    if (eventType === 'email.delivered') {
      return {
        deliveredAt: current.deliveredAt ? undefined : createdAt,
        deliveryStatus: current.deliveryStatus === 'opened'
          ? undefined
          : 'delivered',
      };
    }

    if (eventType === 'email.delivery_delayed') {
      return { deliveryStatus: 'delayed' };
    }

    if (eventType === 'email.bounced') {
      return { deliveryStatus: 'bounced' };
    }

    if (eventType === 'email.complained') {
      return { deliveryStatus: 'complained' };
    }

    if (eventType === 'email.failed') {
      return { deliveryStatus: 'failed' };
    }

    return { deliveryStatus: current.deliveryStatus || 'sent' };
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
      const message = this.resendErrorMessage(data);

      this.logger.warn(
        JSON.stringify({
          event: 'flow_resend_request_failed',
          path,
          statusCode: response.status,
          message,
        }),
      );

      if (response.status >= 400 && response.status < 500) {
        throw new BadRequestException(message);
      }

      throw new InternalServerErrorException(message);
    }

    return data;
  }

  private maxRecipients() {
    return Math.max(1, Number(process.env.FLOW_MAX_RECIPIENTS || 100));
  }

  private envSenderIdentities() {
    const raw =
      process.env.FLOW_SENDERS ||
      process.env.FLOW_DEFAULT_FROM ||
      process.env.RESEND_FROM ||
      '';

    return raw
      .split(';')
      .map(value => value.trim())
      .filter(Boolean)
      .map(value => {
        const name = this.senderDisplayName(value);
        return {
          email: value,
          label: this.senderLabel(value),
          name: name !== 'CHEFU Inc' ? name : undefined,
          source: 'env' as const,
        };
      });
  }

  async senderIdentities(): Promise<Array<{
    addedAt?: string | null;
    email: string;
    label: string;
    name?: string;
    source: 'env' | 'custom';
  }>> {
    const envList = this.envSenderIdentities();
    const sendersByEmail = new Map<string, {
      addedAt?: string | null;
      email: string;
      label: string;
      name?: string;
      source: 'env' | 'custom';
    }>();

    for (const item of envList) {
      const bare = this.emailAddress(item.email);
      if (bare) {
        sendersByEmail.set(bare, item);
      }
    }

    try {
      const snapshot = await this.allowedEmailsCollection()
        .where('status', '==', 'active')
        .get();

      for (const doc of snapshot.docs) {
        const data = doc.data() || {};
        const email = normalizeEmailAddress(String(data.email || doc.id));
        if (!email || !isChefuEmail(email)) continue;

        const name = typeof data.name === 'string' ? data.name.trim() : '';
        const formattedEmail =
          typeof data.formattedEmail === 'string' && data.formattedEmail.trim()
            ? data.formattedEmail.trim()
            : formatSenderIdentity(email, name);
        const label =
          typeof data.label === 'string' && data.label.trim()
            ? data.label.trim()
            : parseSenderLabel(formattedEmail);
        const addedAt = this.firestoreTimestampToIso(data.addedAt);

        sendersByEmail.set(email, {
          addedAt,
          email: formattedEmail,
          label,
          name: name || undefined,
          source: 'custom',
        });
      }
    } catch (error) {
      this.logger.warn(
        `Failed to load custom Flow senders: ${error instanceof Error ? error.message : error}`,
      );
    }

    return Array.from(sendersByEmail.values());
  }

  private async isAllowedSender(sender: string) {
    const senders = await this.senderIdentities();
    if (!senders.length) return true;

    const senderEmail = this.emailAddress(sender);
    return senders.some(
      identity => this.emailAddress(identity.email) === senderEmail,
    );
  }

  private async resolveSender(sender: string) {
    const senderEmail = this.emailAddress(sender);
    if (!senderEmail) return '';

    const senders = await this.senderIdentities();
    if (!senders.length) return sender.trim();

    return (
      senders.find(identity => this.emailAddress(identity.email) === senderEmail)
        ?.email || ''
    );
  }

  private isConfiguredSender(
    sender: string,
    senders: Array<{ email: string; label: string }>,
  ) {
    const senderEmail = this.emailAddress(sender);
    if (!senderEmail) return false;

    return senders.some(
      identity => this.emailAddress(identity.email) === senderEmail,
    );
  }

  private senderLabel(sender: string) {
    const match = sender.match(/^(.+?)\s*<(.+?)>$/);
    if (!match) return sender;

    return `${match[1].replace(/^"|"$/g, '').trim()} (${match[2].trim()})`;
  }

  private senderDisplayName(sender: string) {
    const match = sender.match(/^(.+?)\s*<(.+?)>$/);
    if (match?.[1]) return match[1].replace(/^"|"$/g, '').trim();

    return this.emailAddress(sender).split('@')[0] || 'CHEFU Inc';
  }

  private recipientDisplayName(recipient: FlowRecipient) {
    const name = [recipient.firstName, recipient.lastName]
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .join(' ');

    return name || recipient.email.split('@')[0] || 'there';
  }

  private flowEmailTemplateId() {
    return String(
      process.env.FLOW_EMAIL_TEMPLATE_ID ||
      process.env.RESEND_FLOW_TEMPLATE_ID ||
      '',
    ).trim();
  }

  private isInternalSender(sender: string) {
    const senderEmail = this.emailAddress(sender);
    if (!senderEmail) return false;

    const senderDomain = this.emailDomain(senderEmail);
    if (senderDomain === 'chefu.co.za' || senderDomain.endsWith('.chefu.co.za')) {
      return true;
    }

    return this.internalSenderEmails().has(senderEmail);
  }

  private internalSenderEmails() {
    return new Set(
      [
        ...this.envSenderIdentities().map(identity => identity.email),
        process.env.FLOW_INBOUND_ADDRESS,
        process.env.FLOW_DEFAULT_FROM,
        process.env.RESEND_FROM,
        process.env.FLOW_DEFAULT_REPLY_TO,
      ]
        .map(value => this.emailAddress(value || ''))
        .filter(Boolean),
    );
  }

  private internalSenderDomains() {
    const domains = new Set<string>();

    this.internalSenderEmails().forEach(email => {
      const domain = this.emailDomain(email);
      if (!domain) return;

      domains.add(domain);
      if (domain.endsWith('.chefu.co.za')) {
        domains.add('chefu.co.za');
      }
    });

    return domains;
  }

  private emailAddress(value: string) {
    const match = value.match(/<([^>]+)>/);
    const email = (match?.[1] || value).trim().toLowerCase();

    return /^\S+@\S+\.\S+$/.test(email) ? email : '';
  }

  private emailDomain(email: string) {
    return email.includes('@') ? email.split('@').pop() || '' : '';
  }

  private resendErrorMessage(data: unknown) {
    if (typeof data === 'string' && data.trim()) {
      return data;
    }

    if (!data || typeof data !== 'object') {
      return 'Resend request failed.';
    }

    const payload = data as Record<string, unknown>;
    if (typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message;
    }
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error;
    }

    return 'Resend request failed.';
  }

  private resendTagValue(value: string, fallback: string) {
    const tag = value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);

    return tag || fallback;
  }

  private messagesCollection() {
    return this.firebaseAdmin.db().collection('flowMessages');
  }

  private allowedEmailsCollection() {
    return this.firebaseAdmin.db().collection('flowAllowedEmails');
  }

  /** Converts an email address to a safe Firestore document ID. */
  private emailDocId(email: string) {
    return email.replace(/[.#$/\[\]]/g, '_');
  }

  private firestoreTimestampToIso(value: unknown): string | null {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (
      typeof value === 'object' &&
      'toDate' in value &&
      typeof (value as { toDate: unknown }).toDate === 'function'
    ) {
      const date = (value as { toDate: () => Date }).toDate();
      return date instanceof Date && !Number.isNaN(date.getTime())
        ? date.toISOString()
        : null;
    }
    return null;
  }

  private async findExistingInboundMessage(message: {
    messageId?: string;
    resendEmailId?: string;
  }) {
    if (message.resendEmailId) {
      const snapshot = await this.messagesCollection()
        .where('resendEmailId', '==', message.resendEmailId)
        .limit(1)
        .get();

      if (!snapshot.empty) return snapshot.docs[0].id;
    }

    if (message.messageId) {
      const snapshot = await this.messagesCollection()
        .where('messageId', '==', message.messageId)
        .limit(1)
        .get();

      if (!snapshot.empty) return snapshot.docs[0].id;
    }

    return '';
  }

  private normalizeFolder(value?: string) {
    const folder = String(value || 'inbox').toLowerCase();
    if (folder === 'bin') return 'trash';

    if (
      [
        'inbox',
        'sent',
        'drafts',
        'scheduled',
        'campaigns',
        'archived',
        'trash',
      ].includes(folder)
    ) {
      return folder as FlowMessage['folder'];
    }

    return 'inbox';
  }

  private normalizeMutableFolder(value?: string) {
    const folder = this.normalizeFolder(value);

    if (folder === 'trash') return folder;
    if (['inbox', 'sent', 'drafts', 'scheduled', 'campaigns', 'archived'].includes(folder)) {
      return folder;
    }

    throw new BadRequestException('Folder is not valid.');
  }

  private countFolders(messages: FlowMessage[]): FlowFolderCounts {
    const counts = {
      allmail: 0,
      inbox: 0,
      sent: 0,
      drafts: 0,
      scheduled: 0,
      campaigns: 0,
      archived: 0,
      starred: 0,
      trash: 0,
    };

    messages.forEach(message => {
      if (message.isReaction) return;

      const folder = this.normalizeFolder(message.folder);
      counts[folder] += 1;
      if (folder !== 'trash') counts.allmail += 1;
      if (message.starred) counts.starred += 1;
    });

    return counts;
  }

  private filterMessagesByFolder(messages: FlowMessage[], folder: string) {
    if (folder === 'allmail') {
      return messages.filter(
        message => this.normalizeFolder(message.folder) !== 'trash',
      );
    }

    if (folder === 'starred') {
      const starred = messages.filter(
        message =>
          message.starred && this.normalizeFolder(message.folder) !== 'trash',
      );

      return this.includeThreadSiblings(messages, starred);
    }

    const normalizedFolder = this.normalizeFolder(
      folder === 'bin' ? 'trash' : folder,
    );
    const folderMessages = messages.filter(
      message => message.folder === normalizedFolder,
    );

    if (normalizedFolder === 'trash') return folderMessages;

    return this.includeThreadSiblings(messages, folderMessages);
  }

  private includeThreadSiblings(
    messages: FlowMessage[],
    primaryMessages: FlowMessage[],
  ) {
    if (!primaryMessages.length) return primaryMessages;

    const primaryIds = new Set(primaryMessages.map(message => message.id));
    const threadKeys = new Set(
      primaryMessages
        .map(message => message.threadKey)
        .filter((threadKey): threadKey is string => Boolean(threadKey)),
    );

    if (!threadKeys.size) return primaryMessages;

    return messages.filter(message => {
      if (primaryIds.has(message.id)) return true;
      if (!message.threadKey || !threadKeys.has(message.threadKey)) return false;

      return this.normalizeFolder(message.folder) !== 'trash';
    });
  }

  private toMessage(
    id: string,
    data: Record<string, unknown>,
  ): FlowMessage {
    const attachmentItems = this.normalizeAttachments(data.attachmentItems);
    const isReactionMessage =
      data.isReaction === true || this.isGmailReactionStoredMessage(data);
    const visibleAttachmentItems = isReactionMessage ? [] : attachmentItems;
    const direction = data.direction === 'outbound' ? 'outbound' : 'inbound';
    const from = String(data.from || '');
    const storedFolder = this.normalizeFolder(String(data.folder || 'inbox'));
    const folder =
      direction === 'inbound' &&
        storedFolder === 'inbox' &&
        this.isInternalSender(from)
        ? 'archived'
        : storedFolder;
    const to = Array.isArray(data.to) ? data.to.map(String) : [];
    const messageId =
      typeof data.messageId === 'string'
        ? data.messageId
        : typeof data.message_id === 'string'
          ? data.message_id
          : undefined;
    const subject = String(data.subject || '(no subject)');
    const threadKey =
      typeof data.threadKey === 'string' && data.threadKey.trim()
        ? data.threadKey
        : this.threadKeyForMessage(subject, from, to);
    const reactionEmoji =
      typeof data.reactionEmoji === 'string' && data.reactionEmoji.trim()
        ? data.reactionEmoji
        : isReactionMessage
          ? this.gmailReactionEmoji(
            [data.text, data.preview, data.subject, data.html]
              .filter(value => typeof value === 'string')
              .map(value => this.stripHtml(String(value)))
              .join('\n'),
          )
          : undefined;

    return {
      id,
      attachments: isReactionMessage
        ? visibleAttachmentItems.length
        : Number(data.attachments) || visibleAttachmentItems.length,
      attachmentItems: visibleAttachmentItems,
      clickedAt:
        typeof data.clickedAt === 'string' ? data.clickedAt : undefined,
      clickCount: Number(data.clickCount) || 0,
      createdAt: this.timestampToIso(data.createdAt),
      deliveredAt:
        typeof data.deliveredAt === 'string' ? data.deliveredAt : undefined,
      deliveryStatus:
        typeof data.deliveryStatus === 'string'
          ? data.deliveryStatus
          : undefined,
      direction,
      folder,
      firstOpenedAt:
        typeof data.firstOpenedAt === 'string'
          ? data.firstOpenedAt
          : undefined,
      from,
      html: typeof data.html === 'string' ? data.html : undefined,
      inReplyTo:
        typeof data.inReplyTo === 'string'
          ? data.inReplyTo
          : typeof data.in_reply_to === 'string'
            ? data.in_reply_to
            : undefined,
      isReaction: isReactionMessage,
      label: typeof data.label === 'string' ? data.label : undefined,
      messageId,
      openCount: Number(data.openCount) || 0,
      openedAt:
        typeof data.openedAt === 'string' ? data.openedAt : undefined,
      preview: String(data.preview || ''),
      reactionCount: isReactionMessage
        ? Number(data.reactionCount) || 1
        : undefined,
      reactionEmoji,
      reactionFrom: isReactionMessage
        ? typeof data.reactionFrom === 'string'
          ? data.reactionFrom
          : from
        : undefined,
      receivedAt:
        typeof data.receivedAt === 'string'
          ? data.receivedAt
          : this.timestampToIso(data.receivedAt),
      resendEmailId:
        typeof data.resendEmailId === 'string'
          ? data.resendEmailId
          : typeof data.email_id === 'string'
            ? data.email_id
            : undefined,
      references: this.normalizeReferenceList(data.references),
      sentAt:
        typeof data.sentAt === 'string'
          ? data.sentAt
          : this.timestampToIso(data.sentAt),
      starred: Boolean(data.starred),
      subject,
      text: typeof data.text === 'string' ? data.text : undefined,
      threadKey,
      to,
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
    const messageId = this.firstString(
      email.message_id,
      email.messageId,
      data.message_id,
      data.messageId,
      input.message_id,
      input.messageId,
      this.headerValue(
        [email.headers, data.headers, input.headers],
        ['message-id'],
      ),
    );
    const inReplyTo = this.firstString(
      email.in_reply_to,
      email.inReplyTo,
      data.in_reply_to,
      data.inReplyTo,
      input.in_reply_to,
      input.inReplyTo,
      this.headerValue(
        [email.headers, data.headers, input.headers],
        ['in-reply-to'],
      ),
    );
    const references = this.normalizeReferenceList(
      email.references ||
      data.references ||
      input.references ||
      this.headerValue(
        [email.headers, data.headers, input.headers],
        ['references'],
      ),
    );
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

    const reactionSource = [text, this.stripHtml(html || ''), subject].join(
      '\n',
    );
    const isReactionMessage = this.isGmailReactionText(reactionSource);
    const reactionEmoji = isReactionMessage
      ? this.gmailReactionEmoji(reactionSource)
      : '';
    const attachmentItems = isReactionMessage
      ? []
      : this.normalizeAttachments(email.attachments);

    return {
      attachments: attachmentItems.length,
      attachmentItems,
      from,
      html,
      inReplyTo: inReplyTo || undefined,
      isReaction: isReactionMessage || undefined,
      label: 'Inbound',
      messageId: messageId || undefined,
      preview: isReactionMessage
        ? `Reacted with ${reactionEmoji || 'reaction'}`
        : preview,
      reactionCount: isReactionMessage ? 1 : undefined,
      reactionEmoji: reactionEmoji || undefined,
      reactionFrom: isReactionMessage ? from : undefined,
      references: references.length ? references : undefined,
      receivedAt:
        typeof email.created_at === 'string'
          ? email.created_at
          : typeof data.created_at === 'string'
            ? data.created_at
            : new Date().toISOString(),
      resendEmailId:
        typeof data.email_id === 'string'
          ? data.email_id
          : typeof email.email_id === 'string'
            ? email.email_id
            : undefined,
      subject,
      text: isReactionMessage ? '' : text,
      threadKey: this.threadKeyForMessage(subject, from, to),
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

  private firstString(...values: unknown[]) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }

    return '';
  }

  private headerValue(sources: unknown[], names: string[]) {
    const wanted = new Set(names.map(name => name.toLowerCase()));

    for (const source of sources) {
      const value = this.readHeaderValue(source, wanted);
      if (value) return value;
    }

    return '';
  }

  private readHeaderValue(source: unknown, wanted: Set<string>): string {
    if (!source) return '';

    if (Array.isArray(source)) {
      for (const item of source) {
        const value = this.readHeaderValue(item, wanted);
        if (value) return value;
      }

      return '';
    }

    if (typeof source !== 'object') return '';

    const headers = source as Record<string, unknown>;
    const namedHeader = this.firstString(
      headers.name,
      headers.key,
      headers.header,
    ).toLowerCase();

    if (namedHeader && wanted.has(namedHeader)) {
      return this.firstString(headers.value, headers.text);
    }

    for (const [key, value] of Object.entries(headers)) {
      if (wanted.has(key.toLowerCase())) {
        return this.firstString(value);
      }
    }

    return '';
  }

  private normalizeReferenceList(value: unknown) {
    const values = Array.isArray(value) ? value : [value];

    return [
      ...new Set(
        values
          .flatMap(item => String(item || '').split(/\s+/))
          .map(item => item.trim())
          .filter(Boolean),
      ),
    ];
  }

  private threadKeyForMessage(subject: string, from: string, to: string[]) {
    const subjectKey = this.normalizedThreadSubject(subject) || 'no-subject';
    const participants = [from, ...to]
      .map(value => this.emailAddress(value))
      .filter(Boolean);
    const externalParticipants = participants.filter(
      participant => !this.isInternalSender(participant),
    );
    const threadParticipants = externalParticipants.length
      ? externalParticipants
      : participants;
    const peopleKey =
      [...new Set(threadParticipants)].sort().join(',') || 'unknown';

    return `subject:${subjectKey}|people:${peopleKey}`;
  }

  private normalizedThreadSubject(subject: string) {
    let value = subject.replace(/\s+/g, ' ').trim().toLowerCase();

    while (/^(re|fw|fwd)\s*:/i.test(value)) {
      value = value.replace(/^(re|fw|fwd)\s*:\s*/i, '').trim();
    }

    return value;
  }

  private normalizeAttachments(value: unknown): FlowAttachment[] {
    if (!Array.isArray(value)) return [];

    return value
      .map((item): FlowAttachment | null => {
        if (!item || typeof item !== 'object') return null;

        const attachment = item as Record<string, unknown>;
        const id = String(attachment.id || '').trim();
        if (!id) return null;

        const normalized: FlowAttachment = {
          id,
          filename: String(attachment.filename || 'attachment').trim(),
        };

        const contentType =
          typeof attachment.contentType === 'string'
            ? attachment.contentType
            : typeof attachment.content_type === 'string'
              ? attachment.content_type
              : undefined;
        const contentDisposition =
          typeof attachment.contentDisposition === 'string'
            ? attachment.contentDisposition
            : typeof attachment.content_disposition === 'string'
              ? attachment.content_disposition
              : null;
        const contentId =
          typeof attachment.contentId === 'string'
            ? attachment.contentId
            : typeof attachment.content_id === 'string'
              ? attachment.content_id
              : null;
        const size = Number(attachment.size) || undefined;

        if (contentType) normalized.contentType = contentType;
        normalized.contentDisposition = contentDisposition;
        normalized.contentId = contentId;
        if (size) normalized.size = size;

        return normalized;
      })
      .filter((item): item is FlowAttachment => Boolean(item));
  }

  private isGmailReactionStoredMessage(data: Record<string, unknown>) {
    if (data.isReaction === true) return true;

    return this.isGmailReactionText(
      [data.text, data.preview, data.subject, data.html]
        .filter(value => typeof value === 'string')
        .map(value => this.stripHtml(String(value)))
        .join('\n'),
    );
  }

  private gmailReactionEmoji(value: string) {
    return (
      value.match(
        /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/u,
      )?.[0] || ''
    );
  }

  private isGmailReactionText(value: string) {
    return (
      /\breacted via\s+Gmail\b/i.test(value) ||
      /emojiReactionEmail/i.test(value)
    );
  }

  private withoutUndefined<T extends Record<string, unknown>>(value: T) {
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => entry !== undefined),
    ) as Partial<T>;
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
    const emailId = this.receivedEmailId(input);

    if (!emailId || !this.resendApiKey) return payload;

    const email = await this.getReceivedEmailContent(emailId);
    if (!email) {
      return payload;
    }

    return {
      ...input,
      data: {
        ...data,
        ...(email && typeof email === 'object' ? email : {}),
        email_id: emailId,
      },
    };
  }

  private receivedEmailId(input: Record<string, unknown>) {
    const data =
      input.data && typeof input.data === 'object'
        ? (input.data as Record<string, unknown>)
        : input;
    const email =
      data.email && typeof data.email === 'object'
        ? (data.email as Record<string, unknown>)
        : undefined;

    if (typeof data.email_id === 'string') return data.email_id;
    if (typeof email?.email_id === 'string') return email.email_id;

    return '';
  }

  private async getReceivedEmailContent(emailId: string) {
    const response = await fetch(
      `${this.resendApiUrl}/emails/receiving/${emailId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.resendApiKey}`,
        },
      },
    );
    const data = await response.json().catch(async () => ({
      message: await response.text().catch(() => ''),
    }));

    if (response.status === 404) {
      this.logger.log(
        JSON.stringify({
          event: 'flow_inbound_content_unavailable',
          reason: 'resend_not_found',
          emailId,
          statusCode: response.status,
          storedFallback: 'webhook_metadata',
        }),
      );
      return null;
    }

    if (!response.ok) {
      this.logger.warn(
        `Resend received email lookup failed for email_id=${emailId}: ${JSON.stringify(
          data,
        )}`,
      );
      return null;
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
