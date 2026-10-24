import type { ChefuOauthClient, ChefuRegisteredAppRecord, ChefuApp, ChefuAppId } from "./app-registry.types";
export type { ChefuOauthClient, ChefuRegisteredAppRecord, ChefuApp, ChefuAppId } from "./app-registry.types";

export const CHEFU_APP_HEADER = "x-chefu-app";


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
        id: "quantum",
        name: "Quantum",
        origins: ["https://quantum.chefu.co.za"],
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
        id: "merchant",
        name: "Merchant",
        origins: ["https://merchant.chefu.co.za"],
    },
    {
        id: "cloudence",
        name: "Cloudence",
        origins: ["https://cloudence.chefu.co.za"],
    },
    {
        id: "liftwise",
        name: "LiftWise",
        origins: ["https://liftwise.chefu.co.za"],
    },
];

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
        id: "liftwise-mobile",
        appId: "liftwise",
        name: "LiftWise Mobile",
        redirectUris: ["liftwise://sso-callback"],
        scopes: ["openid", "profile", "email"],
    },
    {
        id: "liftwise-web",
        appId: "liftwise",
        name: "LiftWise Web Development",
        redirectUris: ["https://liftwise.chefu.co.za/sso-callback"],
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
    const app = CHEFU_APPS.find((candidate) => candidate.id === normalized);
    return app?.id || null;
}
