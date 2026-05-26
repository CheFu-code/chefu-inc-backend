import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import crypto from 'crypto';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { ACADEMY_SDK_API_KEY_PREFIX } from './academy-sdk.constants';
import { AcademySdkRequest } from './academy-sdk.types';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 100;

type ParsedApiKey = {
  publicId: string;
};

type RateLimitBucket = {
  resetAt: number;
  count: number;
};

@Injectable()
export class AcademySdkApiKeyGuard implements CanActivate {
  private readonly buckets = new Map<string, RateLimitBucket>();

  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AcademySdkRequest>();
    const rawKey = this.getApiKey(request);

    if (!rawKey) {
      throw new UnauthorizedException('Missing API key.');
    }

    const parsedKey = this.parseApiKey(rawKey);
    if (!parsedKey) {
      throw new ForbiddenException('Invalid API key format.');
    }

    const keyHash = this.hashKey(rawKey);
    this.enforceRateLimit(keyHash);

    const apiKeyDoc = await this.firebaseAdmin
      .db()
      .collection('api_keys')
      .doc(parsedKey.publicId)
      .get();

    if (!apiKeyDoc.exists) {
      throw new ForbiddenException('Invalid API key.');
    }

    const apiKey = apiKeyDoc.data();
    if (
      apiKey?.active !== true ||
      apiKey.keyHash !== keyHash ||
      apiKey.prefix !== ACADEMY_SDK_API_KEY_PREFIX
    ) {
      throw new ForbiddenException('Invalid API key.');
    }

    await apiKeyDoc.ref.update({
      lastUsedAt: new Date(),
    });

    request.apiKey = {
      id: apiKeyDoc.id,
      publicId: parsedKey.publicId,
      ...apiKey,
    };

    return true;
  }

  private getApiKey(request: AcademySdkRequest) {
    const authorization = request.headers.authorization || '';
    if (authorization.startsWith('Bearer ')) {
      return authorization.slice('Bearer '.length).trim();
    }

    const apiKeyHeader = request.headers['x-api-key'];
    return Array.isArray(apiKeyHeader)
      ? apiKeyHeader[0]?.trim()
      : apiKeyHeader?.trim();
  }

  private hashKey(key: string) {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  private parseApiKey(key: string): ParsedApiKey | null {
    const [prefix, publicId, secret, ...extraParts] = key.split('_');

    if (
      prefix !== ACADEMY_SDK_API_KEY_PREFIX ||
      !publicId ||
      !secret ||
      extraParts.length > 0
    ) {
      return null;
    }

    return { publicId };
  }

  private enforceRateLimit(bucketKey: string) {
    const now = Date.now();
    const current = this.buckets.get(bucketKey);

    if (!current || current.resetAt <= now) {
      this.buckets.set(bucketKey, {
        count: 1,
        resetAt: now + RATE_LIMIT_WINDOW_MS,
      });
      return;
    }

    if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
      throw new HttpException(
        'Rate limit exceeded. Please slow down your requests.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    current.count += 1;
  }
}
