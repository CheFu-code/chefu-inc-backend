import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

export const FLOW_ACCESS_COOKIE = 'flow_access';
export const FLOW_ACCESS_SESSION_TTL_SECONDS = 60 * 60 * 12;

export type FlowAccessSession = {
  exp: number;
  iat: number;
  keyId: string;
  label: string;
  permission: FlowAccessPermission;
};

export type FlowAccessPermission = 'read' | 'write' | 'full';

type RegisteredFlowKey = {
  id: string;
  keyHash: string;
  label: string;
  permission: FlowAccessPermission;
  source: 'env' | 'firestore';
};

type FlowAccessKeyStatus = 'active' | 'expired' | 'revoked';

type FlowAccessKeySummary = {
  createdAt: string | null;
  createdBy: string | null;
  expiresAt: string | null;
  id: string;
  label: string;
  permission: FlowAccessPermission;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  status: FlowAccessKeyStatus;
  updatedAt: string | null;
};

type FirestoreRecord = Record<string, unknown>;

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
      throw new ForbiddenException('That Flow key is not active.');
    }

    await this.recordKeyUse(registeredKey, request);
    this.setSessionCookie(response, registeredKey, request);
    return this.sessionPayload(this.createSession(registeredKey));
  }

  async createKey(
    body: {
      expiresAt?: string;
      label?: string;
      permission?: string;
    },
    createdBy?: AuthenticatedUser,
  ) {
    const label = String(body.label || '').trim();

    if (!label) {
      throw new BadRequestException('Add an employee or workspace label for this key.');
    }

    const expiresAt = this.parseOptionalFutureDate(body.expiresAt);
    const permission = this.parsePermission(body.permission);
    const generated = await this.generateUniqueKey();

    await this.keyCollection().doc(generated.keyId).set({
      createdAt: FieldValue.serverTimestamp(),
      createdBy: this.auditIdentity(createdBy),
      expiresAt,
      keyHash: generated.keyHash,
      label,
      permission,
      lastUsedAt: null,
      revokedAt: null,
      revokedBy: null,
      status: 'active',
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      accessKey: generated.accessKey,
      expiresAt: expiresAt?.toISOString() || null,
      keyId: generated.keyId,
      keyLabel: label,
      permission,
      status: 'active',
    };
  }

  async listKeys() {
    const snapshot = await this.keyCollection()
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();

    return {
      keys: snapshot.docs.map(doc => this.keySummary(doc.id, doc.data())),
    };
  }

  async revokeKey(keyId: string, revokedBy?: AuthenticatedUser) {
    const id = this.normalizeKeyId(keyId);
    const docRef = this.keyCollection().doc(id);
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      throw new NotFoundException('Flow access key not found.');
    }

    await docRef.update({
      revokedAt: FieldValue.serverTimestamp(),
      revokedBy: this.auditIdentity(revokedBy),
      status: 'revoked',
      updatedAt: FieldValue.serverTimestamp(),
    });

    const updated = await docRef.get();
    return {
      key: this.keySummary(updated.id, updated.data() || {}),
      success: true,
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

      if (!(await this.keyIsActive(token.keyId))) return null;

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
      permission: token.permission || 'full',
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
      permission: key.permission,
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
    if (!this.isStoredKeyActive(data)) return null;

    return {
      id: snapshot.id,
      keyHash,
      label: String(data.label || 'Flow key'),
      permission: this.parsePermission(data.permission),
      source: 'firestore' as const,
    };
  }

  private async keyIsActive(keyId: string) {
    if (this.envKeys().some(key => key.id === keyId)) return true;

    const snapshot = await this.keyCollection().doc(keyId).get();
    if (!snapshot.exists) return false;

    return this.isStoredKeyActive(snapshot.data() || {});
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
        permission: 'full' as const,
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
        permission: 'full',
        source: 'env',
      },
    ];
  }

  private normalizeKey(value: string) {
    return value.trim().replace(/\s+/g, '').toUpperCase();
  }

  private normalizeKeyId(value: string) {
    const normalized = value.trim().toLowerCase();

    if (!/^[a-f0-9]{16}$/.test(normalized)) {
      throw new BadRequestException('Invalid Flow access key id.');
    }

    return normalized;
  }

  private async generateUniqueKey() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const accessKey = this.generateAccessKey();
      const keyHash = this.hashKey(this.normalizeKey(accessKey));
      const keyId = keyHash.slice(0, 16);
      const existing = await this.keyCollection().doc(keyId).get();

      if (!existing.exists) {
        return { accessKey, keyHash, keyId };
      }
    }

    throw new BadRequestException('Could not generate a unique Flow access key.');
  }

  private generateAccessKey() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const characters = Array.from(randomBytes(20), byte => alphabet[byte % alphabet.length]);
    const groups = [];

    for (let index = 0; index < characters.length; index += 4) {
      groups.push(characters.slice(index, index + 4).join(''));
    }

    return `FLOW-${groups.join('-')}`;
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

  private async recordKeyUse(key: RegisteredFlowKey, request: Request) {
    if (key.source !== 'firestore') return;

    await this.keyCollection()
      .doc(key.id)
      .update({
        lastUsedAt: FieldValue.serverTimestamp(),
        lastUsedIp: this.requestIp(request),
        lastUserAgent: String(request.headers['user-agent'] || '').slice(0, 256),
        updatedAt: FieldValue.serverTimestamp(),
      })
      .catch(() => undefined);
  }

  private requestIp(request: Request) {
    const forwardedFor = request.headers['x-forwarded-for'];

    if (Array.isArray(forwardedFor)) {
      return forwardedFor[0] || request.ip || null;
    }

    if (forwardedFor) {
      return forwardedFor.split(',')[0]?.trim() || request.ip || null;
    }

    return request.ip || null;
  }

  private parseOptionalFutureDate(value?: string) {
    if (!value?.trim()) return null;

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('expiresAt must be a valid date.');
    }

    if (date.getTime() <= Date.now()) {
      throw new BadRequestException('expiresAt must be in the future.');
    }

    return date;
  }

  private isStoredKeyActive(data: FirestoreRecord) {
    return this.keyStatus(data) === 'active';
  }

  private keyStatus(data: FirestoreRecord): FlowAccessKeyStatus {
    if (String(data.status || 'active') === 'revoked') {
      return 'revoked';
    }

    const expiresAt = this.toDate(data.expiresAt);
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      return 'expired';
    }

    return 'active';
  }

  private keySummary(id: string, data: FirestoreRecord): FlowAccessKeySummary {
    return {
      createdAt: this.toIsoString(data.createdAt),
      createdBy: this.nullableString(data.createdBy),
      expiresAt: this.toIsoString(data.expiresAt),
      id,
      label: String(data.label || 'Flow key'),
      permission: this.parsePermission(data.permission),
      lastUsedAt: this.toIsoString(data.lastUsedAt),
      revokedAt: this.toIsoString(data.revokedAt),
      revokedBy: this.nullableString(data.revokedBy),
      status: this.keyStatus(data),
      updatedAt: this.toIsoString(data.updatedAt),
    };
  }

  private parsePermission(value: unknown): FlowAccessPermission {
    if (value === 'read' || value === 'write' || value === 'full') {
      return value;
    }

    return 'full';
  }

  private auditIdentity(user?: AuthenticatedUser) {
    return user?.email || user?.uid || null;
  }

  private nullableString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value : null;
  }

  private toIsoString(value: unknown) {
    return this.toDate(value)?.toISOString() || null;
  }

  private toDate(value: unknown): Date | null {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value === 'string' || typeof value === 'number') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    if (
      typeof value === 'object' &&
      'toDate' in value &&
      typeof value.toDate === 'function'
    ) {
      const date = value.toDate();
      return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
    }

    return null;
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
