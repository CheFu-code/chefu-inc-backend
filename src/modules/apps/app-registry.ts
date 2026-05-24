export const CHEFU_APP_HEADER = 'x-chefu-app';

export type ChefuAppId = 'academy' | 'flow' | 'music';

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
    id: 'music',
    name: 'SoundWave',
    origins: ['http://localhost:3002', 'https://music.chefuinc.com'],
  },
];

export function registeredAppOrigins() {
  return CHEFU_APPS.flatMap(app => app.origins);
}

export function resolveChefuAppId(value?: string): ChefuAppId | null {
  if (!value) return null;

  const normalized = value.trim().toLowerCase();
  const app = CHEFU_APPS.find(candidate => candidate.id === normalized);
  return app?.id || null;
}
