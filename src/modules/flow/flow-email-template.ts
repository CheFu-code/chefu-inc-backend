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

export function renderFlowEmailShell({
  body,
  ctaLabel,
  ctaUrl,
  preheader,
  title,
}: {
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
  preheader?: string;
  title: string;
}) {
  const action =
    ctaLabel && ctaUrl
      ? `<a href="${escapeAttribute(ctaUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;border-radius:8px;padding:12px 18px;font-size:14px;font-weight:700;">${escapeHtml(ctaLabel)}</a>`
      : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f7fb;color:#111827;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader || '')}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fb;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="background:#0f172a;padding:30px 30px;color:#ffffff;">
                <div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#5eead4;">Flow Mail</div>
                <h1 style="margin:16px 0 0;font-size:28px;line-height:1.2;">${escapeHtml(title)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:30px;color:#334155;font-size:15px;line-height:1.7;">
                ${body}
                ${action ? `<div style="margin-top:24px;">${action}</div>` : ''}
              </td>
            </tr>
            <tr>
              <td style="background:#f8fafc;border-top:1px solid #e5e7eb;padding:18px 30px;color:#64748b;font-size:12px;line-height:1.6;">
                Sent with Flow using Resend. You are receiving this because you are part of this audience.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
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

