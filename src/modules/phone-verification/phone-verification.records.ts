import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

export type PhoneChallenge = {
    uid: string; phone: string; nonce: string; verificationSid?: string;
    state: 'sending' | 'pending' | 'checking' | 'approved';
    attempts: number; expiresAtMs: number; leaseUntilMs: number; checkToken?: string;
};
export type VerifiedPhone = { uid: string; phone: string; verifiedAt: string; provider: 'twilio-verify' };
export interface PhoneTransaction {
    get<T>(table: string, uid: string): Promise<T | null>;
    set(table: string, uid: string, value: object): void;
    setContact(email: string, phone: string, verifiedAt: string): void;
}
export interface PhoneRecords {
    get<T>(table: string, uid: string): Promise<T | null>;
    getContact(email: string): Promise<Record<string, unknown>>;
    transaction<T>(work: (tx: PhoneTransaction) => Promise<T>): Promise<T>;
}

@Injectable()
export class PhoneVerificationRecords implements PhoneRecords {
    constructor(private readonly firebase: FirebaseAdminService) { }
    private reference(table: string, uid: string) {
        if (!['challenges', 'verified'].includes(table)) throw new Error('Invalid phone-verification table.');
        return this.firebase.db().collection(`phone_verification_${table}`).doc(createHash('sha256').update(uid).digest('hex'));
    }
    async get<T>(table: string, uid: string): Promise<T | null> {
        const doc = await this.reference(table, uid).get();
        return doc.exists ? doc.data() as T : null;
    }
    async getContact(email: string) {
        return (await this.firebase.db().collection('users').doc(email).get()).data() || {};
    }
    async transaction<T>(work: (tx: PhoneTransaction) => Promise<T>): Promise<T> {
        return this.firebase.db().runTransaction(native => work({
            get: async <V>(table: string, uid: string) => {
                const doc = await native.get(this.reference(table, uid));
                return doc.exists ? doc.data() as V : null;
            },
            set: (table, uid, value) => native.set(this.reference(table, uid), {
                ...value,
                ...(table === 'challenges' ? { expiresAt: Timestamp.fromMillis((value as PhoneChallenge).expiresAtMs) } : {}),
            }),
            // Email comes from AuthGuard, never from the request body. Keep
            // contact storage separate from Firebase phone sign-in/MFA linking.
            setContact: (email, phone, verifiedAt) => {
                native.set(this.firebase.db().collection('users').doc(email), {
                    phone, phoneVerifiedFor: phone, phoneVerifiedAt: verifiedAt, phoneContactSchemaVersion: 1,
                    phoneNumber: FieldValue.delete(), phoneMigrationConflict: FieldValue.delete(),
                }, { merge: true });
            },
        }));
    }
}
