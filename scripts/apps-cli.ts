import { randomUUID } from 'node:crypto';

const [, , command, ...args] = process.argv;

function usage() {
  console.log(`
Chefu Apps CLI

Usage:
  apps-cli create --name "My App" --owner "team@chefu.co.za" --type public --redirect-uri "https://app.example.com/callback" --scope "openid profile email"
  apps-cli list
  apps-cli approve --client-id CLIENT_ID --approved-by admin@chefu.co.za
  apps-cli revoke --client-id CLIENT_ID --approved-by admin@chefu.co.za

Options:
  --name         App name
  --owner        App owner email
  --type         public | confidential
  --redirect-uri Repeatable redirect URI
  --scope        Repeatable scope
  --grant-type   Repeatable grant type
  --client-id    OAuth client id
  --approved-by  Admin approver
  `);
}

function parseArgs(raw: string[]) {
  const output: Record<string, string | string[]> = {};
  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = raw[index + 1] && !raw[index + 1].startsWith('--') ? raw[index + 1] : '';
    if (value) {
      output[key] = Array.isArray(output[key]) ? [...(output[key] as string[]), value] : [value];
      index += 1;
    } else {
      output[key] = '';
    }
  }
  return output;
}

function asList(value: unknown) {
  if (Array.isArray(value)) return value.flatMap(item => String(item).split(',')).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean);
  return [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }

  if (command === 'create') {
    const name = String(args.name || '');
    const owner = String(args.owner || '');
    const type = String(args.type || 'public');
    if (!name || !owner) {
      throw new Error('name and owner are required.');
    }

    const clientId = `chefu-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 8)}`;
    const redirectUris = asList(args['redirect-uri']);
    const scopes = asList(args.scope);
    const grantTypes = asList(args['grant-type']);

    console.log(JSON.stringify({
      action: 'create-app',
      client_id: clientId,
      name,
      owner,
      client_type: type,
      redirect_uris: redirectUris,
      allowed_scopes: scopes,
      grant_types: grantTypes.length ? grantTypes : ['authorization_code'],
      status: 'pending',
      note: 'Persist this in your admin registry or POST it to the backend admin API.',
    }, null, 2));
    return;
  }

  if (command === 'list') {
    console.log(JSON.stringify({ action: 'list-apps' }, null, 2));
    return;
  }

  if (command === 'approve' || command === 'revoke') {
    const clientId = String(args['client-id'] || '');
    const approvedBy = String(args['approved-by'] || 'system');
    if (!clientId) {
      throw new Error('client-id is required.');
    }

    console.log(JSON.stringify({
      action: command,
      client_id: clientId,
      approved_by: approvedBy,
      status: command === 'approve' ? 'approved' : 'revoked',
    }, null, 2));
    return;
  }

  usage();
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
