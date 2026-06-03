import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

import { SecurityEventsService } from './security-events.service';

@Injectable()
export class HoneytokenService {
  private readonly tokenHashes = new Set(
    (process.env.AUTH_HONEYTOKEN_HASHES || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );

  constructor(private readonly securityEvents: SecurityEventsService) {}

  async inspectRequest(request: Request) {
    if (this.tokenHashes.size === 0) {
      return;
    }

    const candidates = this.extractCandidateTokens(request);
    for (const candidate of candidates) {
      const tokenHash = this.securityEvents.hash(candidate);
      if (!this.tokenHashes.has(tokenHash)) {
        continue;
      }

      await this.securityEvents.recordHoneytokenUse({
        fingerprint: this.headerValue(request.headers['x-device-fingerprint']),
        ipHash: this.securityEvents.hash(this.getIp(request)),
        route: `${request.method} ${request.originalUrl || request.url}`,
        tokenHash,
        userAgentHash: request.headers['user-agent']
          ? this.securityEvents.hash(String(request.headers['user-agent']))
          : undefined,
      });

      throw new UnauthorizedException('credential revoked');
    }
  }

  private extractCandidateTokens(request: Request) {
    const candidates: string[] = [];
    const authorization = this.headerValue(request.headers.authorization);
    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch?.[1]) {
      candidates.push(bearerMatch[1].trim());
    }

    const dpopMatch = authorization.match(/^DPoP\s+(.+)$/i);
    if (dpopMatch?.[1]) {
      candidates.push(dpopMatch[1].trim());
    }

    const cookies = (request as Request & { cookies?: Record<string, string> }).cookies;
    for (const cookieName of ['access_token', 'refresh_token', 'session', '__Host-session']) {
      const value = cookies?.[cookieName];
      if (value) {
        candidates.push(value);
      }
    }

    return candidates;
  }

  private getIp(request: Request) {
    const forwardedFor = this.headerValue(request.headers['x-forwarded-for']);
    return forwardedFor.split(',')[0]?.trim() || request.ip || request.socket.remoteAddress || 'unknown';
  }

  private headerValue(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] || '' : value || '';
  }
}
