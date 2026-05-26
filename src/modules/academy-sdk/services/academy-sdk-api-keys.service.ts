import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import crypto from 'crypto';
import { FirebaseAdminService } from '../../firebase-admin/firebase-admin.service';
import { ACADEMY_SDK_API_KEY_PREFIX } from '../academy-sdk.constants';
import { AcademySdkApiKey, AcademySdkUser } from '../academy-sdk.types';

@Injectable()
export class AcademySdkApiKeysService {
  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

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
}
