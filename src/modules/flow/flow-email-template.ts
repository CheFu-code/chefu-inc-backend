export function applyVariables(
    value: string,
    variables: Record<string, string>,
) {
    return value.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
        return variables[key] ?? `{{${key}}}`;
    });
}

export function textToHtml(value: string) {
    return value
        .split(/\n{2,}/)
        .map(paragraph => paragraph.trim())
        .filter(Boolean)
        .map(paragraph => {
            const lines = paragraph
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean);

            if (lines.every(line => line.startsWith('- '))) {
                return `<ul>${lines
                    .map(line => `<li>${escapeHtml(line.slice(2))}</li>`)
                    .join('')}</ul>`;
            }

            return `<p>${lines.map(escapeHtml).join('<br />')}</p>`;
        })
        .join('');
}

export function sanitizeFlowHtml(value: string) {
    return value
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(
            /<\s*(script|style|iframe|object|embed|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
            '',
        )
        .replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*\/?>/gi, '')
        .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/\s+srcdoc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(
            /\s+(href|src)\s*=\s*(['"]?)\s*javascript:[^'"\s>]*/gi,
            ' $1="#"',
        )
        .replace(
            /\s+style\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
            (_match, _full, doubleValue, singleValue, bareValue) => {
                const style = String(doubleValue || singleValue || bareValue || '');
                const cleanStyle = style
                    .split(';')
                    .map(rule => rule.trim())
                    .filter(rule => rule && !/url\s*\(|expression\s*\(/i.test(rule))
                    .join('; ');

                return cleanStyle ? ` style="${escapeAttribute(cleanStyle)}"` : '';
            },
        );
}

export function createFlowTemplateVariables({
    audienceName,
    bodyHtml,
    brandName = 'Flow Mail',
    ctaLabel,
    ctaUrl,
    preheader,
    recipientName,
    senderName,
    title,
}: {
    audienceName: string;
    bodyHtml: string;
    brandName?: string;
    ctaLabel?: string;
    ctaUrl?: string;
    preheader?: string;
    recipientName: string;
    senderName: string;
    title: string;
}) {
    const bodyChunks = chunkTemplateValue(bodyHtml, 5);
    const ctaHtml = renderCtaHtml(ctaLabel, ctaUrl);
    const variables = {
        AUDIENCE_NAME: audienceName || '',
        BODY_HTML_1: bodyChunks[0] || '',
        BODY_HTML_2: bodyChunks[1] || '',
        BODY_HTML_3: bodyChunks[2] || '',
        BODY_HTML_4: bodyChunks[3] || '',
        BODY_HTML_5: bodyChunks[4] || '',
        BRAND_NAME: brandName,
        CTA_HTML: ctaHtml,
        PREHEADER: preheader || title,
        RECIPIENT_NAME: recipientName,
        SENDER_NAME: senderName,
        SUBJECT: title,
    };

    return {
        fitsResendTemplateLimits:
            bodyChunks.length <= 5 &&
            Object.values(variables).every(value => value.length <= 2000),
        variables,
    };
}

export function renderFlowEmailShell({
    audienceName,
    body,
    brandName = 'Flow Mail',
    ctaLabel,
    ctaUrl,
    preheader,
    recipientName,
    senderName,
    title,
}: {
    audienceName?: string;
    body: string;
    brandName?: string;
    ctaLabel?: string;
    ctaUrl?: string;
    preheader?: string;
    recipientName?: string;
    senderName?: string;
    title: string;
}) {
    const action = renderCtaHtml(ctaLabel, ctaUrl);
    const safeAudience = audienceName ? escapeHtml(audienceName) : '';
    const safeBrand = escapeHtml(brandName);
    const safeRecipient = recipientName ? escapeHtml(recipientName) : 'there';
    const safeSender = senderName ? escapeHtml(senderName) : 'CHEFU Technologies';
    const safeTitle = escapeHtml(title);

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safeTitle}</title>
  </head>
  <body style="margin:0;padding:0;background:#eef7f5;color:#10201f;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader || '')}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef7f5;padding:28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#ffffff;border:1px solid #cfe8e3;border-radius:18px;overflow:hidden;box-shadow:0 14px 36px rgba(15,118,110,0.12);">
            <tr>
              <td style="padding:30px 32px 24px;background:#063f3b;color:#ffffff;">
                <div style="display:inline-block;border:1px solid rgba(255,255,255,0.22);border-radius:999px;padding:6px 10px;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#bff7ee;">${safeBrand}</div>
                <h1 style="margin:18px 0 0;font-size:28px;line-height:1.22;color:#ffffff;font-weight:800;">${safeTitle}</h1>
                <p style="margin:12px 0 0;color:#d9fffa;font-size:14px;line-height:1.55;">For ${safeRecipient} from ${safeSender}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;color:#263f3d;font-size:15px;line-height:1.75;">
                ${safeAudience ? `<div style="margin:0 0 22px;padding:12px 14px;border-left:4px solid #14b8a6;background:#f0fdfa;border-radius:0 10px 10px 0;color:#0f766e;font-size:13px;font-weight:700;">${safeAudience}</div>` : ''}
                <div style="font-size:15px;line-height:1.78;color:#263f3d;">${body}</div>
                ${action ? `<div style="margin-top:26px;">${action}</div>` : ''}
              </td>
            </tr>
            <tr>
              <td style="background:#f7fbfa;border-top:1px solid #dcefeb;padding:20px 32px;color:#55716e;font-size:12px;line-height:1.6;">
                Sent with Flow by CHEFU TECHNOLOGIES. Reply to this email to continue the conversation.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function renderCtaHtml(ctaLabel?: string, ctaUrl?: string) {
    if (!ctaLabel || !ctaUrl) return '';

    return `<a href="${escapeAttribute(ctaUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;border-radius:999px;padding:13px 19px;font-size:14px;font-weight:800;box-shadow:0 10px 20px rgba(15,118,110,0.18);">${escapeHtml(ctaLabel)}</a>`;
}

function chunkTemplateValue(value: string, chunkCount: number) {
    const chunkSize = 1900;
    const chunks: string[] = [];

    for (let index = 0; index < value.length; index += chunkSize) {
        chunks.push(value.slice(index, index + chunkSize));
    }

    while (chunks.length < chunkCount) {
        chunks.push('');
    }

    return chunks;
}

function escapeHtml(value: string) {
    const map: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
    };

    return value.replace(/[&<>"']/g, char => map[char]);
}

function escapeAttribute(value: string) {
    return escapeHtml(value).replace(/`/g, '&#096;');
}
