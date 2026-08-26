import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { InfinityPersistedState } from './infinity.types';

@Injectable()
export class InfinityService {
    constructor(
        @Inject(FirebaseAdminService)
        private readonly firebaseAdmin: FirebaseAdminService,
    ) { }

    async getState(user: AuthenticatedUser) {
        const snapshot = await this.stateDocument(user).get();
        return { state: snapshot.exists ? snapshot.data()?.state ?? null : null };
    }

    async saveState(user: AuthenticatedUser, state: InfinityPersistedState) {
        if (!state || typeof state !== 'object') {
            throw new BadRequestException('state is required.');
        }

        await this.stateDocument(user).set({
            state,
            ownerUid: user.uid,
            ownerEmail: user.email,
            updatedAt: FieldValue.serverTimestamp(),
        });

        return { saved: true };
    }

    private stateDocument(user: AuthenticatedUser) {
        return this.firebaseAdmin
            .db()
            .collection('users')
            .doc(user.email || user.uid)
            .collection('infinity')
            .doc('state');
    }
}