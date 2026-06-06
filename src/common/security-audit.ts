import { createHash } from 'crypto';
import { Request } from 'express';
import { getRequestId } from './request-context';

const SENSITIVE_QUERY_PARAMS = new Set([
  'access_token',
  'code',
  'code_challenge',
  'code_verifier',
  'id_token',
  'nonce',
  'refresh_token',
  'returnTo',
  'state',
  'token',
]);

const SENSITIVE_TEXT_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(refresh_token|access_token|id_token|code|code_verifier|token)=([^&\s]+)/gi,
];

export function hashForAudit(value?: string | null) {
  const normalized = value?.trim();
  if (!normalized) return null;

  const secret =
    process.env.AUDIT_LOG_HASH_SECRET ||
    process.env.SIGNIN_ALERT_FINGERPRINT_SECRET ||
    process.env.AUTH_SESSION_SECRET ||
    'chefu-audit-log';

  return createHash('sha256')
    .update(`${secret}:${normalized}`)
    .digest('hex')
    .slice(0, 24);
}

export function redactSensitiveText(value: unknown) {
  const text =
    Array.isArray(value)
      ? value.map(item => String(item)).join('; ')
      : typeof value === 'string'
        ? value
        : value == null
          ? ''
          : JSON.stringify(value);

  return SENSITIVE_TEXT_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, match => {
      const prefix = match.includes('=') ? match.split('=')[0] : 'token';
      return `${prefix}=[redacted]`;
    }),
    text,
  );
}

export function auditRequestContext(request?: Request) {
  if (!request) {
    return {
      requestId: null,
      path: null,
      ipHash: null,
      userAgentHash: null,
      origin: null,
    };
  }

  return {
    requestId: getRequestId(request),
    path: sanitizeUrlForAudit(request.originalUrl || request.url),
    ipHash: hashForAudit(getClientIp(request)),
    userAgentHash: hashForAudit(request.headers['user-agent']?.toString()),
    origin: sanitizeOriginForAudit(request.headers.origin?.toString()),
  };
}

export function sanitizeUrlForAudit(value?: string) {
  if (!value) return null;

  try {
    const url = new URL(value, 'https://audit.local');

    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_PARAMS.has(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }

    const query = url.searchParams.toString();
    return query ? `${url.pathname}?${query}` : url.pathname;
  } catch {
    return '[unparseable]';
  }
}

export function sanitizeOriginForAudit(value?: string) {
  if (!value) return null;

  try {
    return new URL(value).origin;
  } catch {
    return '[unparseable]';
  }
}

export function getClientIp(request: Request) {
  const forwardedFor = request.headers['x-forwarded-for'];
  const firstForwardedIp = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor?.split(',')[0];

  return firstForwardedIp?.trim() || request.ip || undefined;
}
