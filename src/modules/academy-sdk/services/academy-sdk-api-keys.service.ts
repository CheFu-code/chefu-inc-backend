import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import crypto from 'crypto';
import { ResendService } from '../../email/resend.service';
import { FirebaseAdminService } from '../../firebase-admin/firebase-admin.service';
import { ACADEMY_SDK_API_KEY_PREFIX } from '../academy-sdk.constants';
import { AcademySdkApiKey, AcademySdkUser } from '../academy-sdk.types';

const API_KEY_PATTERN = new RegExp(
  `^${ACADEMY_SDK_API_KEY_PREFIX}_([a-f0-9]{16})_([a-f0-9]{48})$`,
);

type ApiKeyLeakReport = {
  apiKey?: string;
  leakedKey?: string;
  source?: string;
  url?: string;
  repository?: string;
  commit?: string;
};

type LeakRequestMeta = {
  ip?: string;
  userAgent?: string;
};

@Injectable()
export class AcademySdkApiKeysService {
  private readonly logger = new Logger(AcademySdkApiKeysService.name);

  constructor(
    private readonly firebaseAdmin: FirebaseAdminService,
    private readonly resendService: ResendService,
  ) {}

  verifyApiKey(apiKey?: AcademySdkApiKey) {
    return {
      valid: true,
      plan: apiKey?.plan || 'free',
    };
  }

  async createApiKey(user: AcademySdkUser, name?: string) {
    this.assertDeveloper(user, 'create API keys');

    const { rawKey, hash, publicId } = await this.generateUniqueApiKey();
    await this.firebaseAdmin.db().collection('api_keys').doc(publicId).set({
      publicId,
      prefix: ACADEMY_SDK_API_KEY_PREFIX,
      keyHash: hash,
      name: this.cleanKeyName(name),
      ownerUid: user.uid,
      ownerEmail: user.email || '',
      active: true,
      plan: 'free',
      createdAt: new Date(),
    });

    return {
      apiKey: rawKey,
      publicId,
      warning: 'Save this key now. You will not see it again.',
    };
  }

  async listApiKeys(user: AcademySdkUser) {
    this.assertDeveloper(user, 'list API keys');

    const snapshot = await this.firebaseAdmin
      .db()
      .collection('api_keys')
      .where('ownerUid', '==', user.uid)
      .orderBy('createdAt', 'desc')
      .get();

    return snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        publicId: data.publicId || doc.id,
        prefix: data.prefix || ACADEMY_SDK_API_KEY_PREFIX,
        name: data.name || 'Untitled key',
        active: data.active === true,
        plan: data.plan || 'free',
        createdAt: data.createdAt || null,
        lastUsedAt: data.lastUsedAt || null,
      };
    });
  }

  async revokeApiKey(user: AcademySdkUser, keyId?: string) {
    this.assertDeveloper(user, 'revoke API keys');
    if (!keyId) {
      throw new BadRequestException('API key id is required.');
    }

    const ref = this.firebaseAdmin.db().collection('api_keys').doc(keyId);
    const snapshot = await ref.get();

    if (!snapshot.exists) {
      throw new NotFoundException('API key not found.');
    }

    if (snapshot.data()?.ownerUid !== user.uid) {
      throw new ForbiddenException('You cannot revoke this API key.');
    }

    await ref.update({ active: false });
    return { success: true };
  }

  async reportLeakedApiKey(
    report: ApiKeyLeakReport,
    meta: LeakRequestMeta = {},
  ) {
    const rawKey = this.cleanLeakKey(report.apiKey || report.leakedKey);
    const parsedKey = this.parseApiKey(rawKey);

    if (!parsedKey) {
      this.logger.warn(
        JSON.stringify({
          event: 'api_key_leak_report_ignored',
          reason: 'invalid_key_format',
          source: this.cleanText(report.source),
          ip: meta.ip || null,
        }),
      );
      return this.genericLeakReportResponse();
    }

    const keyHash = this.hashKey(rawKey);
    const ref = this.firebaseAdmin
      .db()
      .collection('api_keys')
      .doc(parsedKey.publicId);
    const snapshot = await ref.get();
    const keyData = snapshot.data();

    if (
      !snapshot.exists ||
      keyData?.keyHash !== keyHash ||
      keyData.prefix !== ACADEMY_SDK_API_KEY_PREFIX
    ) {
      this.logger.warn(
        JSON.stringify({
          event: 'api_key_leak_report_ignored',
          reason: 'key_not_found_or_hash_mismatch',
          publicId: parsedKey.publicId,
          source: this.cleanText(report.source),
          ip: meta.ip || null,
        }),
      );
      return this.genericLeakReportResponse();
    }

    const now = new Date();
    const alreadyNotified = keyData.compromiseNotifiedAt;
    await ref.set(
      {
        active: false,
        compromised: true,
        compromisedAt: now,
        compromisedReason: 'public_leak_detected',
        compromisedSource: this.cleanText(report.source) || 'unknown',
        compromisedUrl: this.cleanText(report.url),
        compromisedRepository: this.cleanText(report.repository),
        compromisedCommit: this.cleanText(report.commit),
        compromisedReporterIp: meta.ip || '',
        compromisedReporterUserAgent: meta.userAgent || '',
        revokedAt: now,
        revokedReason: 'api_key_leak_detected',
      },
      { merge: true },
    );

    this.logger.warn(
      JSON.stringify({
        event: 'api_key_compromised_revoked',
        publicId: parsedKey.publicId,
        ownerUid: keyData.ownerUid || null,
        ownerEmail: keyData.ownerEmail || null,
        source: this.cleanText(report.source),
      }),
    );

    if (keyData.ownerEmail && !alreadyNotified) {
      try {
        await this.resendService.sendApiKeyCompromisedNotification({
          email: String(keyData.ownerEmail),
          userName: String(keyData.ownerEmail).split('@')[0],
          keyName: String(keyData.name || 'Untitled key'),
          publicId: parsedKey.publicId,
          source: this.cleanText(report.source) || 'a public location',
          url: this.cleanText(report.url),
          timestamp: now,
        });
        await ref.set({ compromiseNotifiedAt: new Date() }, { merge: true });
      } catch (error) {
        this.logger.error(
          JSON.stringify({
            event: 'api_key_compromised_email_failed',
            publicId: parsedKey.publicId,
            reason: error instanceof Error ? error.message : 'unknown',
          }),
        );
      }
    }

    return this.genericLeakReportResponse();
  }

  private async generateUniqueApiKey() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const key = this.generateApiKey();
      const snapshot = await this.firebaseAdmin
        .db()
        .collection('api_keys')
        .doc(key.publicId)
        .get();

      if (!snapshot.exists) {
        return key;
      }
    }

    throw new InternalServerErrorException(
      'Failed to create API key. Please try again.',
    );
  }

  private generateApiKey() {
    const publicId = crypto.randomBytes(8).toString('hex');
    const key = crypto.randomBytes(24).toString('hex');
    const rawKey = `${ACADEMY_SDK_API_KEY_PREFIX}_${publicId}_${key}`;
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');

    return { rawKey, hash, publicId };
  }

  private parseApiKey(rawKey: string) {
    const match = rawKey.match(API_KEY_PATTERN);
    if (!match) return null;

    return {
      publicId: match[1],
    };
  }

  private hashKey(rawKey: string) {
    return crypto.createHash('sha256').update(rawKey).digest('hex');
  }

  private assertDeveloper(user: AcademySdkUser, action: string) {
    if (!user.uid) {
      throw new UnauthorizedException(`Unauthorized attempt to ${action}.`);
    }

    const roles = Array.isArray(user.roles)
      ? user.roles.map(role => role.trim().toLowerCase())
      : [];

    if (!roles.includes('developer')) {
      throw new ForbiddenException(
        'Developer role required to manage API keys.',
      );
    }
  }

  private cleanKeyName(name?: string) {
    const value = typeof name === 'string' ? name.trim() : '';
    return value || 'Untitled key';
  }

  private cleanLeakKey(value?: string) {
    return typeof value === 'string' ? value.trim() : '';
  }

  private cleanText(value?: string) {
    return typeof value === 'string' ? value.trim().slice(0, 500) : '';
  }

  private genericLeakReportResponse() {
    return {
      received: true,
    };
  }
}
