export const CHEFU_APP_HEADER = "x-chefu-app";

export type ChefuAppId =
    | "academy"
    | "admin"
    | "flow"
    | "muzalo"
    | "quantum"
    | "drippybanks"
    | "logix"
    | "logix-dash";
type ChefuAppAlias = "music";

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
        id: "academy",
        name: "CHEFU Academy",
        origins: ["https://academy.chefuinc.com"],
    },
    {
        id: "admin",
        name: "CHEFU Admin",
        origins: ["https://internal.chefuinc.com"],
    },
    {
        id: "flow",
        name: "Flow Mail",
        origins: ["https://flow.chefuinc.com"],
    },
    {
        id: "muzalo",
        name: "Muzalo",
        origins: ["https://muzalo.chefuinc.com"],
    },
    {
        id: "quantum",
        name: "Quantum",
        origins: ["https://quantum.chefuinc.com"],
    },
    {
        id: "logix",
        name: "Logix",
        origins: ["https://logix.chefu.co.za"],
    },
    {
        id: "logix-dash",
        name: "Logix Dashboard",
        origins: ["https://dashboard.logix.chefu.co.za"],
    },
    {
        id: "drippybanks",
        name: "Drippy Banks",
        origins: ["https://drippybanks.chefuinc.com"],
    },
];

const CHEFU_APP_ALIASES: Record<ChefuAppAlias, ChefuAppId> = {
    music: "muzalo",
};

export const CHEFU_OAUTH_CLIENTS: ChefuOauthClient[] = [
    {
        id: "chefu-inc-web",
        appId: "academy",
        name: "CHEFU TECHNOLOGIES",
        redirectUris: [
            "https://chefu.co.za/auth/callback",
            "https://myaccount.chefuinc.com/auth/callback",
        ],
        scopes: ["openid", "profile", "email", "apps:read"],
    },
    {
        id: "chefu-academy-web",
        appId: "academy",
        name: "CHEFU Academy",
        redirectUris: [
            "https://academy.chefuinc.com/auth/callback",
        ],
        scopes: [
            "openid",
            "profile",
            "email",
            "courses:read",
            "videos:read",
            "keys:manage",
        ],
    },
    {
        id: "chefu-academy-mobile",
        appId: "academy",
        name: "CHEFU Academy Mobile",
        redirectUris: ["chefu-academy://auth/sso"],
        scopes: [
            "openid",
            "profile",
            "email",
            "courses:read",
            "videos:read",
            "keys:manage",
        ],
    },
    {
        id: "chefu-admin-web",
        appId: "admin",
        name: "CHEFU Admin",
        redirectUris: [
            "https://internal.chefuinc.com/auth/callback",
        ],
        scopes: ["openid", "profile", "email", "admin:manage"],
    },
    {
        id: "flow-web",
        appId: "flow",
        name: "Flow Mail",
        redirectUris: [
            "https://flow.chefuinc.com/auth/callback",
        ],
        scopes: ["openid", "profile", "email", "flow:read", "flow:send"],
    },
    {
        id: "muzalo-web",
        appId: "muzalo",
        name: "Muzalo",
        redirectUris: [
            "https://muzalo.chefuinc.com/auth/callback",
        ],
        scopes: ["openid", "profile", "email", "music:read"],
    },
    {
        id: "quantum-web",
        appId: "quantum",
        name: "Quantum",
        redirectUris: [
            "https://quantum.chefuinc.com/auth/callback",
        ],
        scopes: ["openid", "profile", "email", "quantum:chat", "quantum:read"],
    },
    {
        id: "quantum-mobile",
        appId: "quantum",
        name: "Quantum Mobile",
        redirectUris: ["quantum://auth"],
        scopes: ["openid", "profile", "email", "quantum:chat", "quantum:read"],
    },
    {
        id: "drippybanks-web",
        appId: "drippybanks",
        name: "Drippy Banks",
        redirectUris: [
            "https://drippybanks.chefuinc.com/auth/callback",
            "https://myaccount.chefuinc.com/auth/callback",
        ],
        scopes: ["openid", "profile", "email"],
    },
];

export function registeredAppOrigins() {
    return CHEFU_APPS.flatMap((app) => app.origins);
}

export function registeredOauthClients() {
    return CHEFU_OAUTH_CLIENTS;
}

export function resolveOauthClient(clientId?: string) {
    if (!clientId) return null;

    return CHEFU_OAUTH_CLIENTS.find((client) => client.id === clientId) || null;
}

export function resolveChefuAppId(value?: string): ChefuAppId | null {
    if (!value) return null;

    const normalized = value.trim().toLowerCase();
    const alias = CHEFU_APP_ALIASES[normalized as ChefuAppAlias];
    if (alias) return alias;

    const app = CHEFU_APPS.find((candidate) => candidate.id === normalized);
    return app?.id || null;
}
