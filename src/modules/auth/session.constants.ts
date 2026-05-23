export const SESSION_COOKIE_NAME = '__session';
export const SESSION_META_COOKIE_NAME = '__session_meta';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 5;

export type SessionMeta = {
  uid: string;
  email: string;
  name?: string;
  roles: string[];
  exp: number;
};
