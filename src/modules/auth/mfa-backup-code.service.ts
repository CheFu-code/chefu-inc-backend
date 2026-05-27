import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import admin from 'firebase-admin';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

type BackupCodeRecord = {
  hash?: unknown;
  usedAt?: unknown;
};

type BackupCodeState = {
  codes?: unknown;
  remaining?: unknown;
  generatedAt?: unknown;
  lastUsedAt?: unknown;
};

@Injectable()
export class MfaBackupCodeService {
  private readonly logger = new Logger(MfaBackupCodeService.name);
  private readonly attempts = new Map<string, number[]>();

  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebaseAdmin: FirebaseAdminService,
  ) {}

  async securitySummary({
    email,
    uid,
  }: {
    email?: string;
    uid?: string;
  }) {
    const normalizedEmail = email?.trim().toLowerCase();

    if (!normalizedEmail || !uid) {
      throw new UnauthorizedException('Authenticated user missing from request.');
    }

    const [userRecord, userSnapshot] = await Promise.all([
      this.firebaseAdmin.auth().getUser(uid),
      this.firebaseAdmin.db().collection('users').doc(normalizedEmail).get(),
    ]);
    const backupState = userSnapshot.data()?.mfaBackupCodes as
      | BackupCodeState
      | undefined;
    const enrolledFactors = userRecord.multiFactor?.enrolledFactors || [];

    return {
      emailVerified: userRecord.emailVerified,
      mfaEnabled: enrolledFactors.length > 0,
      enrolledFactors: enrolledFactors.map(factor => ({
        uid: factor.uid,
        displayName: factor.displayName || null,
        factorId: factor.factorId,
        enrollmentTime: factor.enrollmentTime || null,
      })),
      backupCodesRemaining: Number(backupState?.remaining || 0),
      backupCodesGeneratedAt: this.timestampToIso(backupState?.generatedAt),
      backupCodesLastUsedAt: this.timestampToIso(backupState?.lastUsedAt),
    };
  }

  async generateBackupCodes({
    email,
    uid,
  }: {
    email?: string;
    uid?: string;
  }) {
    const normalizedEmail = email?.trim().toLowerCase();

    if (!normalizedEmail || !uid) {
      throw new UnauthorizedException('Authenticated user missing from request.');
    }

    const codes = Array.from({ length: 10 }, () => this.createBackupCode());
    const now = admin.firestore.FieldValue.serverTimestamp();

    await this.firebaseAdmin
      .db()
      .collection('users')
      .doc(normalizedEmail)
      .set(
        {
          mfaBackupCodes: {
            codes: codes.map(code => ({
              hash: this.hashBackupCode(this.normalizeBackupCode(code), uid),
              createdAt: now,
              usedAt: null,
            })),
            remaining: codes.length,
            generatedAt: now,
            lastUsedAt: null,
          },
          updatedAt: now,
        },
        { merge: true },
      );

    this.logger.warn(
      JSON.stringify({
        event: 'mfa_backup_codes_generated',
        uid,
        email: normalizedEmail,
        count: codes.length,
      }),
    );

    return {
      codes,
      remaining: codes.length,
    };
  }

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

  private createBackupCode() {
    const first = randomBytes(3).toString('hex').toUpperCase();
    const second = randomBytes(3).toString('hex').toUpperCase();

    return `CHFU-${first}-${second}`;
  }

  private timestampToIso(value: unknown) {
    if (
      value &&
      typeof value === 'object' &&
      'toDate' in value &&
      typeof (value as { toDate?: unknown }).toDate === 'function'
    ) {
      return (value as { toDate: () => Date }).toDate().toISOString();
    }

    return null;
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
