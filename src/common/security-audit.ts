import { createHash } from 'crypto';
import { Request } from 'express';
import { getRequestId } from './request-context';

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

/**
 * Audit URL paths only. Query strings routinely contain tokens, email addresses,
 * redirect state and unexpected PII. Logging them is unnecessary for routing
 * diagnostics and increases both disclosure risk and log bandwidth.
 */
export function sanitizeUrlForAudit(value?: string) {
  if (!value) return null;

  try {
    const url = new URL(value, 'https://audit.local');
    return url.pathname
      .replace(/\/[A-Za-z0-9_-]{40,}(?=\/|$)/g, '/[opaque-id]')
      .slice(0, 512);
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
  // Do not trust client-controlled forwarding headers for abuse controls.
  return request.ip || request.socket.remoteAddress || undefined;
}
