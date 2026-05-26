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
import { AcademySdkRequest } from './academy-sdk.types';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 100;

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

    const keyHash = this.hashKey(rawKey);
    this.enforceRateLimit(keyHash);

    const snapshot = await this.firebaseAdmin
      .db()
      .collection('api_keys')
      .where('keyHash', '==', keyHash)
      .where('active', '==', true)
      .limit(1)
      .get();

    if (snapshot.empty) {
      throw new ForbiddenException('Invalid API key.');
    }

    const apiKeyDoc = snapshot.docs[0];
    await apiKeyDoc.ref.update({
      lastUsedAt: new Date(),
    });

    request.apiKey = {
      id: apiKeyDoc.id,
      ...apiKeyDoc.data(),
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
