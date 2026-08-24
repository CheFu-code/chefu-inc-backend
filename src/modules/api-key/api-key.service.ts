import {
    BadRequestException,
    Inject,
    Injectable,
    InternalServerErrorException,
    NotFoundException,
} from '@nestjs/common';
import crypto from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { LRUCache } from 'lru-cache';
import { CachedKey } from '../../configs';

const API_KEY_PREFIX = 'chf';
const MAX_KEYS_PER_USER = 5;
const localCache = new LRUCache<string, CachedKey>({ max: 100_000 })

@Injectable()
export class ApiKeyService {
    constructor(
        @Inject(FirebaseAdminService)
        private readonly firebaseAdmin: FirebaseAdminService,
    ) { }

    private get collection() {
        return this.firebaseAdmin.db().collection('api_keys');
    }

    async createApiKey(userId: string, name?: string) {
        // 1. Check existing active key count for this user in Firestore
        const countSnapshot = await this.collection
            .where('userId', '==', userId)
            .where('active', '==', true)
            .count()
            .get();

        const activeCount = countSnapshot.data().count;

        if (activeCount >= MAX_KEYS_PER_USER) {
            throw new BadRequestException(
                `You have reached the maximum limit of ${MAX_KEYS_PER_USER} API Keys. Please contact support for more.`,
            );
        }

        // 2. Generate cryptographically secure API key
        const { rawKey, keyHash, publicId } = await this.generateUniqueApiKey();

        // 3. Save to Firestore
        await this.collection.doc(publicId).set({
            publicId,
            prefix: API_KEY_PREFIX,
            keyHash,
            name: name?.trim() || 'Default API Key',
            userId,
            active: true,
            createdAt: FieldValue.serverTimestamp(),
            lastUsedAt: null,
        });

        // 4. Return the unhashed raw key only once to the client
        return {
            apiKey: rawKey,
            publicId,
            name: name?.trim() || 'Default API Key',
            warning: 'Save this key now. You will not be able to view it again.',
        };
    }

    async listApiKeys(userId: string) {
        const snapshot = await this.collection
            .where('userId', '==', userId)
            .orderBy('createdAt', 'desc')
            .get();

        return snapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: doc.id,
                publicId: data.publicId || doc.id,
                name: data.name || 'Untitled key',
                active: data.active === true,
                createdAt: data.createdAt?.toDate?.() || data.createdAt || null,
                lastUsedAt: data.lastUsedAt?.toDate?.() || data.lastUsedAt || null,
            };
        });
    }

    async revokeApiKey(userId: string, publicId: string) {
        const docRef = this.collection.doc(publicId);
        const doc = await docRef.get();

        if (!doc.exists || doc.data()?.userId !== userId) {
            throw new BadRequestException('API key not found.');
        }

        await docRef.update({
            active: false,
            revokedAt: FieldValue.serverTimestamp(),
        });

        return { success: true };
    }

    async deleteApiKey(userId: string, publicId: string) {
        const normalizedId = String(publicId || '').trim();
        if (!normalizedId || !userId) {
            throw new BadRequestException('API key ID is required.');
        }
        const docRef = this.collection.doc(normalizedId);
        const doc = await docRef.get();
        if (!doc.exists || doc.data()?.userId !== userId) {
            throw new NotFoundException('API key not found.');
        }
        await docRef.delete();
        localCache.delete(normalizedId);
        return { success: true };
    }

    private async generateUniqueApiKey() {
        for (let attempt = 0; attempt < 5; attempt++) {
            const publicId = crypto.randomBytes(8).toString('hex');
            const secret = crypto.randomBytes(24).toString('hex');
            const rawKey = `${API_KEY_PREFIX}_${publicId}_${secret}`;
            const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

            const existing = await this.collection.doc(publicId).get();
            if (!existing.exists) {
                return { rawKey, keyHash, publicId };
            }
        }

        throw new InternalServerErrorException('Failed to generate a unique API key.');
    }
}
