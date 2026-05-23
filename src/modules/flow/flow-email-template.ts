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
      ? `<a href="${escapeAttribute(ctaUrl)}" style="display:inline-block;background:#1a73e8;color:#ffffff;text-decoration:none;border-radius:999px;padding:12px 18px;font-size:14px;font-weight:700;">${escapeHtml(ctaLabel)}</a>`
      : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f7fb;color:#202124;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader || '')}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fb;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#ffffff;border:1px solid #dfe4ea;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:26px 30px;border-bottom:1px solid #dfe4ea;">
                <div style="font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#1a73e8;">Flow Mail</div>
                <h1 style="margin:12px 0 0;font-size:26px;line-height:1.25;color:#202124;">${escapeHtml(title)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:30px;color:#3c4043;font-size:15px;line-height:1.75;">
                ${body}
                ${action ? `<div style="margin-top:24px;">${action}</div>` : ''}
              </td>
            </tr>
            <tr>
              <td style="background:#f8fafc;border-top:1px solid #dfe4ea;padding:18px 30px;color:#5f6368;font-size:12px;line-height:1.6;">
                Sent with Flow Mail by CheFu Inc.
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
