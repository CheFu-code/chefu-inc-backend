import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

export const FLOW_ACCESS_COOKIE = 'flow_access';
export const FLOW_ACCESS_SESSION_TTL_SECONDS = 60 * 60 * 12;

export type FlowAccessSession = {
  exp: number;
  iat: number;
  keyId: string;
  label: string;
};

type RegisteredFlowKey = {
  id: string;
  keyHash: string;
  label: string;
  source: 'env' | 'firestore';
};

@Injectable()
export class FlowAccessKeyService {
  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebaseAdmin: FirebaseAdminService,
  ) {}

  async sessionFromRequest(request: Request) {
    return this.verifyAccessToken(request.cookies?.[FLOW_ACCESS_COOKIE]);
  }

  async login(accessKey: string, response: Response, request: Request) {
    const registeredKey = await this.findRegisteredKey(accessKey);

    if (!registeredKey) {
      throw new ForbiddenException('That Flow key is not registered.');
    }

    this.setSessionCookie(response, registeredKey, request);
    return this.sessionPayload(this.createSession(registeredKey));
  }

  async register(
    body: {
      accessKey?: string;
      label?: string;
      registrationCode?: string;
    },
    response: Response,
    request: Request,
  ) {
    if (!this.canRegisterWithSecret(body.registrationCode || '')) {
      throw new ForbiddenException('The registration code is not valid.');
    }

    const normalized = this.normalizeKey(body.accessKey || '');
    const label = String(body.label || '').trim();

    if (!label) {
      throw new BadRequestException('Add an employee or workspace label for this key.');
    }

    if (normalized.length < 10) {
      throw new BadRequestException('Use an access key with at least 10 characters.');
    }

    const existing = await this.findRegisteredKey(normalized);
    if (existing) {
      throw new BadRequestException('That Flow key is already registered.');
    }

    const keyHash = this.hashKey(normalized);
    const keyId = keyHash.slice(0, 16);
    const key: RegisteredFlowKey = {
      id: keyId,
      keyHash,
      label,
      source: 'firestore',
    };

    await this.keyCollection().doc(keyId).set({
      createdAt: FieldValue.serverTimestamp(),
      keyHash,
      label,
      updatedAt: FieldValue.serverTimestamp(),
    });

    this.setSessionCookie(response, key, request);
    return {
      ...this.sessionPayload(this.createSession(key)),
      keyId,
      keyLabel: label,
    };
  }

  clearSession(response: Response) {
    const cookieOptions = this.clearCookieOptions();

    response.clearCookie(FLOW_ACCESS_COOKIE, cookieOptions);
    response.cookie(FLOW_ACCESS_COOKIE, '', {
      ...cookieOptions,
      expires: new Date(0),
      maxAge: 0,
    });

    return { granted: false };
  }

  async verifyAccessToken(value?: string) {
    if (!value) return null;

    const [payload, signature] = value.split('.');
    if (!payload || !signature) return null;

    if (!this.safeEqual(signature, this.sign(payload))) return null;

    try {
      const token = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as FlowAccessSession;

      if (!token.keyId || token.exp < Math.floor(Date.now() / 1000)) {
        return null;
      }

      if (!(await this.keyExists(token.keyId))) return null;

      return token;
    } catch {
      return null;
    }
  }

  sessionPayload(token: FlowAccessSession | null) {
    if (!token) return { granted: false };

    return {
      expiresAt: new Date(token.exp * 1000).toISOString(),
      granted: true,
      keyLabel: token.label,
    };
  }

  private setSessionCookie(
    response: Response,
    key: RegisteredFlowKey,
    request: Request,
  ) {
    response.cookie(FLOW_ACCESS_COOKIE, this.createAccessToken(key), {
      httpOnly: true,
      secure: this.isSecureCookie(request),
      sameSite: 'lax',
      path: '/',
      domain: this.cookieDomain(),
      maxAge: FLOW_ACCESS_SESSION_TTL_SECONDS * 1000,
    });
  }

  private createSession(key: RegisteredFlowKey): FlowAccessSession {
    const issuedAt = Math.floor(Date.now() / 1000);

    return {
      exp: issuedAt + FLOW_ACCESS_SESSION_TTL_SECONDS,
      iat: issuedAt,
      keyId: key.id,
      label: key.label,
    };
  }

  private createAccessToken(key: RegisteredFlowKey) {
    const payload = Buffer.from(
      JSON.stringify(this.createSession(key)),
    ).toString('base64url');

    return `${payload}.${this.sign(payload)}`;
  }

  private async findRegisteredKey(accessKey: string) {
    const keyHash = this.hashKey(this.normalizeKey(accessKey));
    const envKey = this.envKeys().find(key => this.safeEqual(key.keyHash, keyHash));

    if (envKey) return envKey;

    const snapshot = await this.keyCollection().doc(keyHash.slice(0, 16)).get();
    if (!snapshot.exists) return null;

    const data = snapshot.data() || {};
    if (!this.safeEqual(String(data.keyHash || ''), keyHash)) return null;

    return {
      id: snapshot.id,
      keyHash,
      label: String(data.label || 'Flow key'),
      source: 'firestore' as const,
    };
  }

  private async keyExists(keyId: string) {
    if (this.envKeys().some(key => key.id === keyId)) return true;
    return (await this.keyCollection().doc(keyId).get()).exists;
  }

  private envKeys(): RegisteredFlowKey[] {
    const entries = String(
      process.env.FLOW_REGISTERED_KEYS || process.env.FLOW_ACCESS_KEYS || '',
    )
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean);

    const configured = entries.map((entry, index) => {
      const [maybeLabel, ...rest] = entry.split(':');
      const value = rest.length ? rest.join(':') : maybeLabel;
      const label = rest.length ? maybeLabel.trim() : `Flow key ${index + 1}`;
      const keyHash = this.hashKey(this.normalizeKey(value));

      return {
        id: keyHash.slice(0, 16),
        keyHash,
        label: label || `Flow key ${index + 1}`,
        source: 'env' as const,
      };
    });

    if (configured.length || process.env.NODE_ENV === 'production') {
      return configured;
    }

    const keyHash = this.hashKey(this.normalizeKey('FLOW-DEMO-2026'));
    return [
      {
        id: keyHash.slice(0, 16),
        keyHash,
        label: 'Development Flow key',
        source: 'env',
      },
    ];
  }

  private canRegisterWithSecret(value: string) {
    const secret =
      process.env.FLOW_REGISTRATION_SECRET ||
      process.env.FLOW_ADMIN_REGISTRATION_KEY ||
      (process.env.NODE_ENV === 'production' ? '' : 'FLOW-REGISTER-2026');

    return Boolean(secret && this.safeEqual(value.trim(), secret.trim()));
  }

  private normalizeKey(value: string) {
    return value.trim().replace(/\s+/g, '').toUpperCase();
  }

  private hashKey(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private sign(payload: string) {
    return createHmac('sha256', this.signingSecret())
      .update(payload)
      .digest('base64url');
  }

  private signingSecret() {
    return (
      process.env.FLOW_ACCESS_SECRET ||
      process.env.AUTH_SESSION_SECRET ||
      process.env.SESSION_COOKIE_SECRET ||
      (process.env.NODE_ENV === 'production'
        ? ''
        : 'flow-local-development-secret')
    );
  }

  private safeEqual(left: string, right: string) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);

    if (leftBuffer.length !== rightBuffer.length) return false;
    return timingSafeEqual(leftBuffer, rightBuffer);
  }

  private keyCollection() {
    return this.firebaseAdmin.db().collection('flowAccessKeys');
  }

  private cookieDomain() {
    if (process.env.NODE_ENV !== 'production') return undefined;
    return (
      process.env.FLOW_ACCESS_COOKIE_DOMAIN ||
      process.env.AUTH_COOKIE_DOMAIN ||
      undefined
    );
  }

  private isSecureCookie(request: Request) {
    return (
      process.env.NODE_ENV === 'production' ||
      request.protocol === 'https' ||
      request.headers['x-forwarded-proto'] === 'https'
    );
  }

  private clearCookieOptions() {
    return {
      path: '/',
      domain: this.cookieDomain(),
    };
  }
}
