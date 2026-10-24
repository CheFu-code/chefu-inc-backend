export type ChefuAppId =
    | "academy"
    | "admin"
    | "flow"
    | "quantum"
    | "logix"
    | "logix-dash"
    | "merchant"
    | "cloudence"
    | "liftwise"
    | "root";
    
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