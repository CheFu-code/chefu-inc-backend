import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  applyVariables,
  renderFlowEmailShell,
  textToHtml,
} from './flow-email-template';
import { FlowRecipient, FlowSendPayload } from './flow-email.types';

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

  getConfig() {
    return {
      defaultFrom:
        process.env.FLOW_DEFAULT_FROM ||
        process.env.RESEND_FROM ||
        'Flow <onboarding@resend.dev>',
      defaultReplyTo: process.env.FLOW_DEFAULT_REPLY_TO || '',
      maxRecipients: this.maxRecipients(),
      resendConfigured: Boolean(this.resendApiKey),
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

    return {
      action: normalized.action,
      audienceName: normalized.audienceName,
      count: emails.length,
      data: response,
      sentAt: new Date().toISOString(),
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
    if (!payload.subject || payload.subject.trim().length < 2) {
      throw new BadRequestException('Subject is required.');
    }
    if (!payload.html || payload.html.trim().length < 20) {
      throw new BadRequestException('Message body is required.');
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
      company: recipient.company || 'CheFu Academy',
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
}

