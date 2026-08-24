import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.join(rootDir, 'resend', 'flow-mail-template.html');
const envPath = path.join(rootDir, '.env');

const localEnv = await readLocalEnv(envPath);
const apiKey = process.env.RESEND_API_KEY || localEnv.RESEND_API_KEY;
const alias =
  process.env.FLOW_EMAIL_TEMPLATE_ID ||
  localEnv.FLOW_EMAIL_TEMPLATE_ID ||
  'flow-mail-default';

if (!apiKey) {
  console.error('RESEND_API_KEY is required to sync the Flow Resend template.');
  process.exit(1);
}

const html = await readFile(htmlPath, 'utf8');
const template = {
  alias,
  from: process.env.FLOW_DEFAULT_FROM || 'Flow Mail <mail@chefu.co.za>',
  html,
  name: 'Flow Mail Default',
  subject: '{{SUBJECT}}',
  variables: [
    'AUDIENCE_NAME',
    'BODY_HTML_1',
    'BODY_HTML_2',
    'BODY_HTML_3',
    'BODY_HTML_4',
    'BODY_HTML_5',
    'BRAND_NAME',
    'CTA_HTML',
    'PREHEADER',
    'RECIPIENT_NAME',
    'SENDER_NAME',
    'SUBJECT',
  ].map(key => ({ key, type: 'string' })),
};

const existing = await getTemplate(alias);
const templateId = existing?.id || alias;

if (existing) {
  await resendRequest('PATCH', `/templates/${encodeURIComponent(templateId)}`, template);
  console.log(`Updated Resend template "${alias}".`);
} else {
  const created = await resendRequest('POST', '/templates', template);
  console.log(`Created Resend template "${alias}" (${created.id}).`);
}

await resendRequest('POST', `/templates/${encodeURIComponent(alias)}/publish`);
console.log(`Published Resend template "${alias}".`);

async function getTemplate(idOrAlias) {
  const response = await fetch(
    `https://api.resend.com/templates/${encodeURIComponent(idOrAlias)}`,
    {
      headers: resendHeaders(),
      method: 'GET',
    },
  );

  if (response.status === 404) return null;
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || `Resend template lookup failed: ${response.status}`);
  }

  return data;
}

async function resendRequest(method, resourcePath, body) {
  const response = await fetch(`https://api.resend.com${resourcePath}`, {
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      ...resendHeaders(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    method,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || `Resend request failed: ${response.status}`);
  }

  return data;
}

function resendHeaders() {
  return {
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': 'chefu-flow-template-sync/1.0',
  };
}

async function readLocalEnv(filePath) {
  try {
    const content = await readFile(filePath, 'utf8');

    return Object.fromEntries(
      content
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && line.includes('='))
        .map(line => {
          const index = line.indexOf('=');
          const key = line.slice(0, index).trim();
          const value = line
            .slice(index + 1)
            .trim()
            .replace(/^"|"$/g, '');

          return [key, value];
        }),
    );
  } catch {
    return {};
  }
}
