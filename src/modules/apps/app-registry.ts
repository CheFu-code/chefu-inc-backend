export const CHEFU_APP_HEADER = 'x-chefu-app';

export type ChefuAppId = 'academy' | 'flow' | 'muzalo';
type ChefuAppAlias = 'music';

export type ChefuApp = {
  id: ChefuAppId;
  name: string;
  origins: string[];
};

export const CHEFU_APPS: ChefuApp[] = [
  {
    id: 'academy',
    name: 'CheFu Academy',
    origins: [
      'http://localhost:3000',
      'https://chefuinc.com',
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
];

const CHEFU_APP_ALIASES: Record<ChefuAppAlias, ChefuAppId> = {
  music: 'muzalo',
};

export function registeredAppOrigins() {
  return CHEFU_APPS.flatMap(app => app.origins);
}

export function resolveChefuAppId(value?: string): ChefuAppId | null {
  if (!value) return null;

  const normalized = value.trim().toLowerCase();
  const alias = CHEFU_APP_ALIASES[normalized as ChefuAppAlias];
  if (alias) return alias;

  const app = CHEFU_APPS.find(candidate => candidate.id === normalized);
  return app?.id || null;
}
