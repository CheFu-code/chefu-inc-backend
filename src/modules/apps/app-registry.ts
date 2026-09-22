export const CHEFU_APP_HEADER = "x-chefu-app";

export type ChefuAppId =
    | "academy"
    | "admin"
    | "flow"
    | "muzalo"
    | "quantum"
    | "infinity"
    | "drippybanks"
    | "logix"
    | "logix-dash"
    | "merchant"
    | "cloudence"
    | "root";
type ChefuAppAlias = "music";

export type ChefuApp = {
    id: ChefuAppId;
    name: string;
    origins: string[];
};

export type ChefuAppStatus = "pending" | "approved" | "revoked";
export type ChefuClientType = "public" | "confidential";

export type ChefuOauthClient = {
    id: string;
    appId: ChefuAppId;
    name: string;
    redirectUris: string[];
    scopes: string[];
};

export type ChefuRegisteredAppRecord = {
    client_id: string;
    app_id?: string;
    name: string;
    owner: string;
    client_type: ChefuClientType;
    status: ChefuAppStatus;
    redirect_uris: string[];
    allowed_scopes: string[];
    grant_types: string[];
    created_at?: string | number | Date;
    approved_by?: string | null;
    approved_at?: string | number | Date | null;
};

export type ChefuAppSecretRecord = {
    app_id: string;
    client_id: string;
    secret_hash: string;
    secret_version: string;
    expires_at?: string | number | Date | null;
    rotated_at?: string | number | Date | null;
    created_at?: string | number | Date;
};

export function mapAppRecordToOauthClient(record: ChefuRegisteredAppRecord): ChefuOauthClient | null {
    if (!record.client_id || record.status !== "approved") {
        return null;
    }

    const appId = resolveChefuAppId(record.app_id || record.name);
    if (!appId) {
        return null;
    }

    return {
        id: record.client_id,
        appId,
        name: record.name,
        redirectUris: Array.isArray(record.redirect_uris) ? record.redirect_uris : [],
        scopes: Array.isArray(record.allowed_scopes) ? record.allowed_scopes : [],
    };
}

export const CHEFU_APPS: ChefuApp[] = [
    {
        id: "academy",
        name: "Chefu Academy",
        origins: ["https://academy.chefu.co.za"],
    },
    {
        id: "root",
        name: "Chefu Technologies",
        origins: [
            "https://chefu.co.za",
            "https://www.chefu.co.za",
            "https://myaccount.chefu.co.za",
        ],
    },
    {
        id: "admin",
        name: "Chefu Admin",
        origins: ["https://internal.chefu.co.za"],
    },
    {
        id: "flow",
        name: "Flow Mail",
        origins: ["https://flow.chefu.co.za"],
    },
    {
        id: "muzalo",
        name: "Muzalo",
        origins: ["https://muzalo.chefu.co.za"],
    },
    {
        id: "quantum",
        name: "Quantum",
        origins: ["https://quantum.chefu.co.za"],
    },
    {
        id: "infinity",
        name: "Infinity",
        origins: ["https://infinity.chefu.co.za"],
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
        origins: ["https://drippybanks.chefu.co.za"],
    },
    {
        id: "merchant",
        name: "Merchant",
        origins: ["https://merchant.chefu.co.za"],
    },
    {
        id: "cloudence",
        name: "Cloudence",
        origins: ["https://cloudence.chefu.co.za"],
    },
];

const CHEFU_APP_ALIASES: Record<ChefuAppAlias, ChefuAppId> = {
    music: "muzalo",
};

export const CHEFU_OAUTH_CLIENTS: ChefuOauthClient[] = [
    {
        id: "chefu-technologies",
        appId: "root",
        name: "Chefu Technologies",
        redirectUris: [
            "https://chefu.co.za/auth/callback",
            "https://myaccount.chefu.co.za/auth/callback",
        ],
        scopes: ["openid", "profile", "email", "apps:read"],
    },
    {
        id: "chefu-academy-web",
        appId: "academy",
        name: "Chefu Academy",
        redirectUris: ["https://academy.chefu.co.za/auth/callback"],
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
        name: "Chefu Academy Mobile",
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
        name: "Chefu Admin",
        redirectUris: ["https://internal.chefu.co.za/auth/callback"],
        scopes: ["openid", "profile", "email", "admin:manage"],
    },
    {
        id: "chefu-merchant-web",
        appId: "merchant",
        name: "Chefu Merchant",
        redirectUris: ["https://merchant.chefu.co.za/auth/callback"],
        scopes: ["openid", "profile", "email", "admin:manage"],
    },
    {
        id: "flow-web",
        appId: "flow",
        name: "Flow Mail",
        redirectUris: ["https://flow.chefu.co.za/auth/callback"],
        scopes: ["openid", "profile", "email", "flow:read", "flow:send"],
    },
    {
        id: "muzalo-web",
        appId: "muzalo",
        name: "Muzalo",
        redirectUris: ["https://muzalo.chefu.co.za/auth/callback"],
        scopes: ["openid", "profile", "email", "music:read"],
    },
    {
        id: "quantum-web",
        appId: "quantum",
        name: "Quantum",
        redirectUris: ["https://quantum.chefu.co.za/auth/callback"],
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
        id: "infinity-mobile",
        appId: "infinity",
        name: "Infinity Mobile",
        redirectUris: ["infinity://auth"],
        scopes: ["openid", "profile", "email"],
    },
    {
        id: "infinity-web",
        appId: "infinity",
        name: "Infinity Web",
        redirectUris: ["https://infinity.chefu.co.za/auth/callback"],
        scopes: ["openid", "profile", "email"],
    },
    {
        id: "drippybanks-web",
        appId: "drippybanks",
        name: "Drippy Banks",
        redirectUris: [
            "https://drippybanks.chefu.co.za/auth/callback",
            "https://myaccount.chefu.co.za/auth/callback",
        ],
        scopes: ["openid", "profile", "email"],
    },
    {
        id: "cloudence-web",
        appId: "cloudence",
        name: "Cloudence",
        redirectUris: ["https://cloudence.chefu.co.za/auth/callback"],
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
