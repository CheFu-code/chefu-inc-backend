import { BadRequestException } from '@nestjs/common';
import { CHEFU_APPS, resolveOauthClient } from './app-registry';

export type RegistrationInput = {
  appId: string; clientId?: string; name: string; owner: string;
  origins: string[]; redirectUris: string[]; allowedScopes: string[];
  clientType?: 'public' | 'confidential'; status?: 'pending' | 'approved';
};
const slug = /^[a-z][a-z0-9-]{1,63}$/;
export function validateRegistration(input: RegistrationInput) {
  if (!input || typeof input !== 'object') throw new BadRequestException('Application details are required.');
  const allowed = ['appId', 'clientId', 'name', 'owner', 'origins', 'redirectUris', 'allowedScopes', 'clientType', 'status'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new BadRequestException('Unexpected registration fields.');
  if (typeof input.appId !== 'string' || !slug.test(input.appId)) throw new BadRequestException('App ID must be a lowercase slug, 2–64 characters.');
  if (CHEFU_APPS.some(app => app.id === input.appId) || ['internal', 'infinity', 'nook', 'logix', 'logix-dash'].includes(input.appId)) throw new BadRequestException('This app ID is reserved by an existing platform app.');
  if (input.clientId !== undefined && (typeof input.clientId !== 'string' || !slug.test(input.clientId) || resolveOauthClient(input.clientId))) throw new BadRequestException('Choose a unique lowercase client ID, 2–64 characters.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) throw new BadRequestException('App name is required (maximum 100 characters).');
  if (typeof input.owner !== 'string' || input.owner.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.owner)) throw new BadRequestException('A valid owner email is required.');
  if (!['public', 'confidential'].includes(input.clientType || 'public')) throw new BadRequestException('Invalid client type.');
  if (!['pending', 'approved'].includes(input.status || 'approved')) throw new BadRequestException('Invalid registration status.');
  for (const key of ['origins', 'redirectUris', 'allowedScopes'] as const) {
    if (!Array.isArray(input[key]) || input[key].length > 20 || input[key].some(value => typeof value !== 'string' || value.length > 2048)) throw new BadRequestException(`Invalid ${key}. Maximum 20 entries.`);
  }
  if (!input.redirectUris.length) throw new BadRequestException('At least one exact callback URL is required.');
  const origins = [...new Set(input.origins.map(origin => {
    const url = safeUrl(origin);
    if (!webUrl(url) || origin !== url.origin) throw new BadRequestException('Origins must be exact HTTPS origins without a path or wildcard. HTTP is allowed only on localhost.');
    return url.origin;
  }))];
  const redirectUris = [...new Set(input.redirectUris.map(uri => {
    const url = safeUrl(uri);
    if (!webUrl(url) && (input.clientType === 'confidential' || !/^[a-z][a-z0-9+.-]*:$/.test(url.protocol) || ['http:', 'https:', 'javascript:', 'data:', 'file:', 'ftp:', 'about:', 'blob:'].includes(url.protocol))) throw new BadRequestException('Use an HTTPS callback or a native app callback for a public client.');
    if (webUrl(url) && !origins.includes(url.origin)) throw new BadRequestException('Each web callback must belong to one of the registered origins.');
    return uri;
  }))];
  const scopes = [...new Set(input.allowedScopes)];
  if (!scopes.includes('openid') || scopes.some(scope => !['openid', 'profile', 'email'].includes(scope))) throw new BadRequestException('Select identity scopes: openid, profile, and/or email. openid is required.');
  return { ...input, name: input.name.trim(), owner: input.owner.trim().toLowerCase(), origins, redirectUris, allowedScopes: scopes };
}
function safeUrl(value: string) {
  try {
    const url = new URL(value);
    if (value !== value.trim() || /[\s\\*]/.test(value) || /%(?:00|0a|0d|5c)/i.test(value) || url.username || url.password || url.hash) throw new Error();
    return url;
  } catch { throw new BadRequestException('Invalid origin or callback URL. Wildcards, fragments, and embedded credentials are not allowed.'); }
}
function webUrl(url: URL) { return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)); }
