export const SESSION_COOKIE_NAME = '__session';
export const SESSION_META_COOKIE_NAME = '__session_meta';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 5;
export const SESSION_META_AUDIENCE = 'chefu-account-web';
export const SESSION_META_ISSUER = 'chefu-api-session';

export type SessionMeta = {
  aud: typeof SESSION_META_AUDIENCE;
  uid: string;
  email: string;
  name?: string;
  roles: string[];
  iat: number;
  exp: number;
  iss: typeof SESSION_META_ISSUER;
};
