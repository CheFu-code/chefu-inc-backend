import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import admin from 'firebase-admin';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

type BackupCodeRecord = {
  hash?: unknown;
  usedAt?: unknown;
};

type BackupCodeState = {
  codes?: unknown;
  remaining?: unknown;
};

@Injectable()
export class MfaBackupCodeService {
  private readonly logger = new Logger(MfaBackupCodeService.name);
  private readonly attempts = new Map<string, number[]>();

  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

  async consumeBackupCode({
    email,
    code,
    mfaPendingCredential,
    ip,
  }: {
    email?: string;
    code?: string;
    mfaPendingCredential?: string;
    ip?: string;
  }) {
    const normalizedEmail = email?.trim().toLowerCase();
    const normalizedCode = this.normalizeBackupCode(code || '');

    if (!normalizedEmail || !normalizedCode) {
      throw new BadRequestException('Email and backup code are required.');
    }

    if (!mfaPendingCredential || mfaPendingCredential.length < 20) {
      throw new BadRequestException('A recent MFA challenge is required.');
    }

    this.enforceThrottle(`${ip || 'unknown'}:${normalizedEmail}`);

    const userRecord = await this.firebaseAdmin
      .auth()
      .getUserByEmail(normalizedEmail)
      .catch(() => null);

    if (!userRecord) {
      throw new UnauthorizedException('Invalid recovery code.');
    }

    const userRef = this.firebaseAdmin.db().collection('users').doc(normalizedEmail);
    const hash = this.hashBackupCode(normalizedCode, userRecord.uid);
    const matched = await this.firebaseAdmin.db().runTransaction(async tx => {
      const snapshot = await tx.get(userRef);
      const data = snapshot.data();
      const backupState = data?.mfaBackupCodes as BackupCodeState | undefined;
      const codes = Array.isArray(backupState?.codes)
        ? (backupState.codes as BackupCodeRecord[])
        : [];

      const index = codes.findIndex(record => {
        if (typeof record.hash !== 'string' || record.usedAt) return false;
        return this.safeEqual(record.hash, hash);
      });

      if (index < 0) return false;

      const nextCodes = codes.map((record, currentIndex) =>
        currentIndex === index
          ? {
              ...record,
              usedAt: admin.firestore.FieldValue.serverTimestamp(),
            }
          : record,
      );
      const remaining = nextCodes.filter(record => !record.usedAt).length;

      tx.set(
        userRef,
        {
          mfaBackupCodes: {
            ...backupState,
            codes: nextCodes,
            remaining,
            lastUsedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
        },
        { merge: true },
      );

      return true;
    });

    if (!matched) {
      throw new UnauthorizedException('Invalid recovery code.');
    }

    const customToken = await this.firebaseAdmin.auth().createCustomToken(userRecord.uid, {
      mfa_recovery: true,
    });

    this.logger.warn(
      JSON.stringify({
        event: 'mfa_backup_code_consumed',
        uid: userRecord.uid,
        email: normalizedEmail,
      }),
    );

    return { customToken };
  }

  private normalizeBackupCode(code: string) {
    return code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  }

  private hashBackupCode(code: string, salt: string) {
    return createHash('sha256').update(`${salt}:${code}`).digest('hex');
  }

  private safeEqual(a: string, b: string) {
    const first = Buffer.from(a, 'hex');
    const second = Buffer.from(b, 'hex');

    return first.length === second.length && timingSafeEqual(first, second);
  }

  private enforceThrottle(key: string) {
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
    const maxAttempts = 5;
    const attempts = (this.attempts.get(key) || []).filter(
      timestamp => now - timestamp < windowMs,
    );

    if (attempts.length >= maxAttempts) {
      throw new HttpException(
        'Too many recovery attempts. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    attempts.push(now);
    this.attempts.set(key, attempts);
  }
}
