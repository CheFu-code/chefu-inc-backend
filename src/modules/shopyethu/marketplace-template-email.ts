import { setTimeout as delay } from 'node:timers/promises';
import { assertResendConfigured } from '../../common/env';

// Resend substitutes triple-brace variables without escaping HTML text nodes.
export const escapeTemplateText = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!);

type TemplateEmail = {
  to: string; subject: string; templateId: string; variables: Record<string, string>;
  idempotencyKey: string; failureLabel: string;
};

export async function sendMarketplaceTemplateEmail(email: TemplateEmail): Promise<void> {
  assertResendConfigured();
  const body = JSON.stringify({
    from: 'ShopYethu <notifications@chefu.co.za>', to: [email.to], subject: email.subject,
    template: { id: email.templateId, variables: email.variables },
  });
  // Exactly the same payload/key on bounded transient retries. Never retry a mutation here.
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: {
          Authorization: `Bearer ${(process.env.RESEND_API_KEY || '').trim()}`,
          'Content-Type': 'application/json', 'Idempotency-Key': email.idempotencyKey,
        },
        body, signal: AbortSignal.timeout(3000),
      });
    } catch {
      if (attempt === 0) { await delay(250); continue; }
      throw new Error(`${email.failureLabel} could not reach Resend.`);
    }
    await response.body?.cancel();
    if (response.ok) return;
    if (attempt === 0 && response.status >= 500) { await delay(250); continue; }
    // Configuration failures and rate limits require intervention/provider backoff.
    throw new Error(`${email.failureLabel} failed (HTTP ${response.status}).`);
  }
}
