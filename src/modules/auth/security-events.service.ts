import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import * as crypto from 'crypto';

import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

export const ACCOUNT_SECURITY_ACTIVITY_TYPES = [
  'password_changed',
  'password_reset_email_sent',
  'passkey_registered',
  'passkey_deleted',
  'mfa_enabled',
  'mfa_disabled',
  'recovery_codes_generated',
  'recovery_code_used',
  'verification_email_sent',
  'email_verified',
  'signed_in',
  'signed_out',
] as const;

export type AccountSecurityActivityType =
  (typeof ACCOUNT_SECURITY_ACTIVITY_TYPES)[number];

const ACCOUNT_ACTIVITY_LABELS: Record<AccountSecurityActivityType, string> = {
  password_changed: 'Password changed',
  password_reset_email_sent: 'Password reset email sent',
  passkey_registered: 'Passkey added',
  passkey_deleted: 'Passkey removed',
  mfa_enabled: 'Two-factor authentication enabled',
  mfa_disabled: 'Two-factor authentication disabled',
  recovery_codes_generated: 'Recovery codes generated',
  recovery_code_used: 'Recovery code used',
  verification_email_sent: 'Verification email sent',
  email_verified: 'Email address verified',
  signed_in: 'Signed in',
  signed_out: 'Signed out',
};

type SubjectRevocationInput = {
  uid?: string;
  email?: string;
  reason?: string;
  actor?: string;
  ipHash?: string;
};

type TokenRevocationSubject = {
  sub: string;
  email?: string;
  iat?: number;
  jti?: string;
};

@Injectable()
export class SecurityEventsService {
  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

  async recordAccountActivity(input: {
    uid: string;
    email: string;
    eventType: AccountSecurityActivityType;
    deviceName?: string;
  }) {
    const email = input.email.trim().toLowerCase();
    const eventId = crypto.randomUUID();
    const userRef = this.firebaseAdmin.db().collection('users').doc(email);
    const event = {
        createdAt: Timestamp.now(),
        eventId,
        eventType: input.eventType,
        ...(input.deviceName ? { deviceName: input.deviceName.slice(0, 100) } : {}),
        uidHash: this.hash(input.uid),
    };

    await this.firebaseAdmin.db().runTransaction(async transaction => {
      const snapshot = await transaction.get(userRef);
      const existing = snapshot.data()?.recentSecurityActivity;
      const activities = Array.isArray(existing) ? existing : [];
      transaction.set(
        userRef,
        { recentSecurityActivity: [event, ...activities].slice(0, 20) },
        { merge: true },
      );
    });

    return { eventId };
  }

  async listAccountActivity(email: string, uid: string) {
    const snapshot = await this.firebaseAdmin
      .db()
      .collection('users')
      .doc(email.trim().toLowerCase())
      .get();
    const events = snapshot.data()?.recentSecurityActivity;
    if (!Array.isArray(events)) return [];

    return events.flatMap((data: Record<string, unknown>) => {
      if (
        typeof data.eventType !== 'string' ||
        !ACCOUNT_SECURITY_ACTIVITY_TYPES.includes(
          data.eventType as AccountSecurityActivityType,
        ) ||
        data.uidHash !== this.hash(uid)
      ) {
        return [];
      }

      const eventType = data.eventType as AccountSecurityActivityType;
      return [{
        eventId: typeof data.eventId === 'string' ? data.eventId : '',
        eventType,
        label: ACCOUNT_ACTIVITY_LABELS[eventType],
        deviceName: typeof data.deviceName === 'string' ? data.deviceName : null,
        createdAt: this.timestampToIso(data.createdAt),
      }];
    });
  }

  async publishSubjectRevocation(input: SubjectRevocationInput) {
    const subject = input.uid || input.email?.toLowerCase();
    if (!subject) {
      throw new BadRequestException('uid or email is required for subject revocation');
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const reason = input.reason || 'session_revoked';
    const db = this.firebaseAdmin.db();
    const eventId = crypto.randomUUID();

    await db.collection('security_subject_revocations').doc(subject).set(
      {
        actor: input.actor || 'system',
        email: input.email?.toLowerCase() || null,
        ipHash: input.ipHash || null,
        reason,
        revokedAfter: nowSeconds,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await db.collection('security_events').doc(eventId).set({
      createdAt: FieldValue.serverTimestamp(),
      eventId,
      eventType: 'https://schemas.openid.net/secevent/caep/event-type/session-revoked',
      reason,
      severity: 'high',
      subject,
      subjectEmailHash: input.email ? this.hash(input.email.toLowerCase()) : null,
      subjectUidHash: input.uid ? this.hash(input.uid) : null,
    });

    return { eventId, revokedAfter: nowSeconds, subject };
  }

  async assertTokenNotRevoked(token: TokenRevocationSubject) {
    const subject = token.sub || token.email?.toLowerCase();
    if (!subject) {
      return;
    }

    const snapshot = await this.firebaseAdmin
      .db()
      .collection('security_subject_revocations')
      .doc(subject)
      .get();

    if (!snapshot.exists) {
      return;
    }

    const data = snapshot.data() as { revokedAfter?: number; reason?: string } | undefined;
    const revokedAfter = Number(data?.revokedAfter || 0);
    const issuedAt = Number(token.iat || 0);

    if (revokedAfter > 0 && issuedAt > 0 && issuedAt <= revokedAfter) {
      throw new UnauthorizedException(data?.reason || 'token revoked by security event');
    }
  }

  async recordHoneytokenUse(input: {
    fingerprint?: string;
    ipHash?: string;
    route?: string;
    tokenHash: string;
    userAgentHash?: string;
  }) {
    const eventId = crypto.randomUUID();

    await this.firebaseAdmin.db().collection('security_events').doc(eventId).set({
      createdAt: FieldValue.serverTimestamp(),
      eventId,
      eventType: 'urn:chefu:security-event:honeytoken-used',
      fingerprint: input.fingerprint || null,
      ipHash: input.ipHash || null,
      route: input.route || null,
      severity: 'critical',
      tokenHash: input.tokenHash,
      userAgentHash: input.userAgentHash || null,
    });

    return { eventId };
  }

  hash(value: string) {
    return crypto.createHash('sha256').update(value).digest('hex');
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
}
