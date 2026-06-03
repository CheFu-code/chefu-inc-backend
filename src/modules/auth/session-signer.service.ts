import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  SESSION_META_AUDIENCE,
  SESSION_META_ISSUER,
  SessionMeta,
} from './session.constants';

@Injectable()
export class SessionSignerService {
  sign(meta: SessionMeta) {
    const payload = this.base64UrlEncode(JSON.stringify(meta));
    const signature = this.createSignature(payload);
    return `${payload}.${signature}`;
  }

  verify(value?: string): SessionMeta | null {
    if (!value) return null;

    const [payload, signature] = value.split('.');
    if (!payload || !signature) return null;

    const expected = this.createSignature(payload);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    if (
      actualBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      return null;
    }

    try {
      const meta = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as Partial<SessionMeta>;

      if (!this.isValidSessionMeta(meta)) return null;

      return meta;
    } catch {
      return null;
    }
  }

  private createSignature(payload: string) {
    return createHmac('sha256', this.getSecret())
      .update(payload)
      .digest('base64url');
  }

  private base64UrlEncode(value: string) {
    return Buffer.from(value, 'utf8').toString('base64url');
  }

  private getSecret() {
    const secret =
      process.env.AUTH_SESSION_SECRET ||
      process.env.SESSION_COOKIE_SECRET ||
      process.env.FIREBASE_SERVICE_ACCOUNT;

    if (!secret) {
      throw new Error('AUTH_SESSION_SECRET is not configured.');
    }

    return secret;
  }

  private isValidSessionMeta(meta: Partial<SessionMeta>): meta is SessionMeta {
    const now = Math.floor(Date.now() / 1000);
    const maxAgeSeconds = 60 * 60 * 24 * 7;
    const { exp, iat } = meta;

    return (
      meta.aud === SESSION_META_AUDIENCE &&
      meta.iss === SESSION_META_ISSUER &&
      typeof meta.uid === 'string' &&
      meta.uid.length > 0 &&
      typeof meta.email === 'string' &&
      Array.isArray(meta.roles) &&
      meta.roles.every(role => typeof role === 'string') &&
      typeof iat === 'number' &&
      typeof exp === 'number' &&
      Number.isInteger(iat) &&
      Number.isInteger(exp) &&
      iat <= now + 60 &&
      exp > now &&
      exp - iat <= maxAgeSeconds
    );
  }
}
