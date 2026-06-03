import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import * as crypto from 'crypto';

import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

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
}
