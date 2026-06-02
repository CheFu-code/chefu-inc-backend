export const CHEFU_APP_HEADER = 'x-chefu-app';

export type ChefuAppId = 'academy' | 'flow' | 'muzalo' | 'quantum';
type ChefuAppAlias = 'music';

export type ChefuApp = {
  id: ChefuAppId;
  name: string;
  origins: string[];
};

export type ChefuOauthClient = {
  id: string;
  appId: ChefuAppId;
  name: string;
  redirectUris: string[];
  scopes: string[];
};

export const CHEFU_APPS: ChefuApp[] = [
  {
    id: 'academy',
    name: 'CheFu Academy',
    origins: [
      'http://localhost:3000',
      'https://chefuinc.com',
      'https://myaccount.chefuinc.com',
      'https://academy.chefuinc.com',
    ],
  },
  {
    id: 'flow',
    name: 'Flow Mail',
    origins: ['http://localhost:3001', 'https://flow.chefuinc.com'],
  },
  {
    id: 'muzalo',
    name: 'Muzalo',
    origins: [
      'http://localhost:3002',
      'https://muzalo.chefuinc.com',
      'https://music.chefuinc.com',
    ],
  },
  {
    id: 'quantum',
    name: 'Quantum',
    origins: ['http://localhost:3003', 'https://quantum.chefuinc.com'],
  },
];

const CHEFU_APP_ALIASES: Record<ChefuAppAlias, ChefuAppId> = {
  music: 'muzalo',
};

export const CHEFU_OAUTH_CLIENTS: ChefuOauthClient[] = [
  {
    id: 'chefu-inc-web',
    appId: 'academy',
    name: 'CheFu Inc',
    redirectUris: [
      'https://chefuinc.com/auth/callback',
      'https://myaccount.chefuinc.com/auth/callback',
      'http://localhost:3000/auth/callback',
    ],
    scopes: ['openid', 'profile', 'email', 'apps:read'],
  },
  {
    id: 'chefu-academy-web',
    appId: 'academy',
    name: 'CheFu Academy',
    redirectUris: [
      'https://academy.chefuinc.com/auth/callback',
      'http://localhost:3000/auth/callback',
    ],
    scopes: [
      'openid',
      'profile',
      'email',
      'courses:read',
      'videos:read',
      'keys:manage',
    ],
  },
  {
    id: 'flow-web',
    appId: 'flow',
    name: 'Flow Mail',
    redirectUris: [
      'https://flow.chefuinc.com/auth/callback',
      'http://localhost:3001/auth/callback',
    ],
    scopes: ['openid', 'profile', 'email', 'flow:read', 'flow:send'],
  },
  {
    id: 'muzalo-web',
    appId: 'muzalo',
    name: 'Muzalo',
    redirectUris: [
      'https://muzalo.chefuinc.com/auth/callback',
      'https://music.chefuinc.com/auth/callback',
      'http://localhost:3002/auth/callback',
    ],
    scopes: ['openid', 'profile', 'email', 'music:read'],
  },
  {
    id: 'quantum-web',
    appId: 'quantum',
    name: 'Quantum',
    redirectUris: [
      'https://quantum.chefuinc.com/auth/callback',
      'http://localhost:3003/auth/callback',
    ],
    scopes: ['openid', 'profile', 'email', 'quantum:chat', 'quantum:read'],
  },
  {
    id: 'quantum-mobile',
    appId: 'quantum',
    name: 'Quantum Mobile',
    redirectUris: ['quantum://auth'],
    scopes: ['openid', 'profile', 'email', 'quantum:chat', 'quantum:read'],
  },
];

export function registeredAppOrigins() {
  return CHEFU_APPS.flatMap(app => app.origins);
}

export function registeredOauthClients() {
  return CHEFU_OAUTH_CLIENTS;
}

export function resolveOauthClient(clientId?: string) {
  if (!clientId) return null;

  return CHEFU_OAUTH_CLIENTS.find(client => client.id === clientId) || null;
}

export function resolveChefuAppId(value?: string): ChefuAppId | null {
  if (!value) return null;

  const normalized = value.trim().toLowerCase();
  const alias = CHEFU_APP_ALIASES[normalized as ChefuAppAlias];
  if (alias) return alias;

  const app = CHEFU_APPS.find(candidate => candidate.id === normalized);
  return app?.id || null;
}
