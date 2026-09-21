#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChefuClient } from '@chefu/sdk';

const API_BASE_URL = process.env.CHEFU_API_BASE_URL || 'https://api.chefu.co.za';
const HOME_DIR = os.homedir();
const CONFIG_DIR = path.join(HOME_DIR, '.chefu');
const TOKEN_PATH = path.join(CONFIG_DIR, 'config.json');
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;

const colors = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  cyan: '\u001B[36m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  red: '\u001B[31m',
  dim: '\u001B[2m',
};

function style(code, text) {
  return USE_COLOR ? `${code}${text}${colors.reset}` : text;
}

function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

function printSuccess(message, details = '') {
  console.log(style(colors.green, '✓') + ' ' + style(colors.bold, message));
  if (details) console.log(style(colors.dim, details));
}

function printInfo(message) {
  console.log(style(colors.cyan, '›') + ' ' + style(colors.bold, message));
}

function printError(message) {
  console.error(style(colors.red, '✖') + ' ' + style(colors.bold, message));
}

function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function readStoredSession() {
  try {
    const raw = fs.readFileSync(TOKEN_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeStoredSession(session) {
  ensureConfigDir();
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(session, null, 2));
}

function clearStoredSession() {
  try {
    fs.unlinkSync(TOKEN_PATH);
  } catch {
    // no-op
  }
}

function buildClient(session = readStoredSession()) {
  const client = new ChefuClient({ baseURL: API_BASE_URL });
  if (session?.token) {
    client.setToken(session.token);
  }
  return client;
}

async function cmdLogin(args, jsonOutput) {
  const email = args.email || args.e;
  const password = args.password || args.p;

  if (!email || !password) {
    throw new Error('Usage: chefu login --email you@example.com --password secret');
  }

  const client = buildClient();
  const result = await client.login({ email, password });

  const session = {
    email,
    token: result.token || result.idToken || '',
    refreshToken: result.refreshToken || '',
    updatedAt: new Date().toISOString(),
  };

  writeStoredSession(session);

  if (jsonOutput) {
    printJson({ ok: true, user: { email }, token: session.token });
    return;
  }

  printSuccess('Logged in successfully.', `User: ${email}`);
}

async function cmdLogout(jsonOutput) {
  const session = readStoredSession();
  const client = buildClient(session);

  if (session?.token) {
    try {
      await client.logout();
    } catch {
      // ignore server-side signout errors; still clear local login
    }
  }

  clearStoredSession();

  if (jsonOutput) {
    printJson({ ok: true, loggedOut: true });
    return;
  }

  printSuccess('Logged out.');
}

async function cmdWhoAmI(jsonOutput) {
  const session = readStoredSession();
  if (!session?.token) {
    throw new Error('Not logged in. Run: chefu login --email ... --password ...');
  }

  const client = buildClient(session);
  const result = await client.whoami();

  if (jsonOutput) {
    printJson(result);
    return;
  }

  const user = result?.user || result;
  const profile = result?.profile || {};
  printInfo(`Authenticated as: ${user?.email || profile?.email || 'unknown'}`);
  console.log(JSON.stringify({ user, profile }, null, 2));
}

async function cmdAppsList(jsonOutput) {
  const session = readStoredSession();
  if (!session?.token) {
    throw new Error('Not logged in. Run: chefu login --email ... --password ...');
  }

  const client = buildClient(session);
  const result = await client.apps.list();

  if (jsonOutput) {
    printJson(result);
    return;
  }

  printInfo('Apps');
  console.log(JSON.stringify(result, null, 2));
}

async function cmdAppsRegister(args, jsonOutput) {
  const session = readStoredSession();
  if (!session?.token) {
    throw new Error('Not logged in. Run: chefu login --email ... --password ...');
  }

  const payload = {
    appId: args.appId || args.a || '',
    name: args.name || '',
    owner: args.owner || '',
    redirectUris: (args['redirect-uri'] || args.redirectUri || args.r || '').split(',').map(item => item.trim()).filter(Boolean),
    allowedScopes: (args.scope || args.s || '').split(',').map(item => item.trim()).filter(Boolean),
    grantTypes: (args['grant-type'] || '').split(',').map(item => item.trim()).filter(Boolean),
    clientType: (args.type === 'confidential' ? 'confidential' : 'public'),
    status: (args.status === 'approved' || args.status === 'revoked' ? args.status : 'pending'),
  };

  if (!payload.appId || !payload.name || !payload.owner) {
    throw new Error('Usage: chefu apps register --appId flow --name "My App" --owner user@chefu.co.za --type confidential --redirect-uri "https://app.example.com/callback" --scope "openid,profile,email"');
  }

  const client = buildClient(session);
  const result = await client.apps.register(payload);

  if (jsonOutput) {
    printJson(result);
    return;
  }

  printSuccess('App registered.', `Client ID: ${result?.record?.client_id || result?.client_id || 'unknown'}`);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdAppsApprove(args, jsonOutput) {
  const session = readStoredSession();
  if (!session?.token) {
    throw new Error('Not logged in. Run: chefu login --email ... --password ...');
  }

  const clientId = args['client-id'] || args.clientId || args.c;
  const approvedBy = args['approved-by'] || args.approvedBy || session.email;

  if (!clientId) {
    throw new Error('Usage: chefu apps approve --client-id CLIENT_ID --approved-by admin@chefu.co.za');
  }

  const client = buildClient(session);
  const result = await client.apps.approve(clientId, approvedBy);

  if (jsonOutput) {
    printJson(result);
    return;
  }

  printSuccess('App approved.', `Client ID: ${clientId}`);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdAppsRotateSecret(args, jsonOutput) {
  const session = readStoredSession();
  if (!session?.token) {
    throw new Error('Not logged in. Run: chefu login --email ... --password ...');
  }

  const clientId = args['client-id'] || args.clientId || args.c;
  if (!clientId) {
    throw new Error('Usage: chefu apps rotate-secret --client-id CLIENT_ID');
  }

  const client = buildClient(session);
  const result = await client.apps.rotateSecret(clientId);

  if (jsonOutput) {
    printJson(result);
    return;
  }

  printSuccess('Secret rotated.', `Client ID: ${clientId}`);
  console.log(JSON.stringify(result, null, 2));
}

function parseArgs(argv) {
  const result = {};
  const booleanFlags = new Set(['json', 'j', 'help', 'h']);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      result._ = [...(result._ || []), token];
      continue;
    }

    const key = token.slice(2);
    if (booleanFlags.has(key)) {
      result[key] = true;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._?.[0];
  const jsonOutput = Boolean(args.json || args.j);

  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      console.log(`
Chefu CLI

Usage:
  chefu login --email user@chefu.co.za --password secret
  chefu logout
  chefu whoami

  chefu apps list
  chefu apps register --appId flow --name "My App" --owner user@chefu.co.za --type confidential --redirect-uri "https://app.example.com/callback" --scope "openid,profile,email"
  chefu apps approve --client-id CLIENT_ID --approved-by admin@chefu.co.za
  chefu apps rotate-secret --client-id CLIENT_ID

Flags:
  --json   Output raw JSON for scripts and automation
`);
      return;
    }

    if (command === 'login') {
      await cmdLogin(args, jsonOutput);
      return;
    }

    if (command === 'logout') {
      await cmdLogout(jsonOutput);
      return;
    }

    if (command === 'whoami') {
      await cmdWhoAmI(jsonOutput);
      return;
    }

    if (command === 'apps') {
      const sub = args._?.[1];
      if (!sub) throw new Error('Missing subcommand for apps.');

      if (sub === 'list') {
        await cmdAppsList(jsonOutput);
        return;
      }

      if (sub === 'register') {
        await cmdAppsRegister(args, jsonOutput);
        return;
      }

      if (sub === 'approve') {
        await cmdAppsApprove(args, jsonOutput);
        return;
      }

      if (sub === 'rotate-secret') {
        await cmdAppsRotateSecret(args, jsonOutput);
        return;
      }

      throw new Error('Unknown apps command.');
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (jsonOutput) {
      printJson({ ok: false, error: message });
    } else {
      printError(message);
    }
    process.exit(1);
  }
}

main();
