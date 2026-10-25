import { createHash } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import { HttpException } from '@nestjs/common';
import { trustedBrowserLimits } from './trusted-browser-limits';
import type { Request } from 'express';
import type { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { isTrustedDeviceInvalidatedByCredentialChange } from './device-auth';

const milliseconds = (value: unknown): number => {
    if (!value || typeof value !== 'object' || !('toMillis' in value) || typeof value.toMillis !== 'function') return 0;
    return value.toMillis();
};

type Owner = { email: string; expiresAt: number };
export class TrustedBrowserStatusReader {
    private inFlight = 0;
    private readonly cache = new LRUCache<string, Promise<Owner | null>>({ max: 1000, ttl: 30_000 });
    constructor(private readonly firebase: FirebaseAdminService) {}
    async check(request: Request, cookieName: string, emailValue?: unknown): Promise<{ trusted: boolean }> {
        if (emailValue !== undefined && (typeof emailValue !== 'string' || emailValue.length > 254)) return { trusted: false };
        const email = typeof emailValue === 'string' ? emailValue.trim().toLowerCase() : '';
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { trusted: false };
        const token = request.cookies?.[cookieName];
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return { trusted: false };
        const hash = createHash('sha256').update(token).digest('hex');
        trustedBrowserLimits.reserve(`cookie:${hash}`, 12);
        let pending = this.cache.get(hash);
        if (!pending) {
            if (this.inFlight >= 8) throw new HttpException({ trusted: false, retryAfterSeconds: 2 }, 429);
            // This non-evictable process budget bounds cold database lookups
            // even if an attacker rotates cookies and IPs to evict LRU entries.
            trustedBrowserLimits.reserve('database', 100);
            this.inFlight++;
            pending = this.load(hash).finally(() => { this.inFlight--; });
            this.cache.set(hash, pending);
            try {
                const owner = await pending;
                if (!owner && this.cache.get(hash) === pending) this.cache.set(hash, pending, { ttl: 10_000 });
            } catch (error) {
                if (this.cache.get(hash) === pending) this.cache.delete(hash);
                throw error;
            }
        }
        const owner = await pending;
        return { trusted: Boolean(owner && owner.expiresAt > Date.now() && (!email || owner.email === email)) };
    }
    private async load(hash: string): Promise<Owner | null> {
        const firebase = this.firebase;
        const snapshot = await firebase.db().collection('auth_trusted_devices')
            .doc(hash).get();
        const device = snapshot.data();
        if (!snapshot.exists || typeof device?.uid !== 'string' || !device.uid || device.uid.includes('/') || device.revokedAt || milliseconds(device.expiresAt) <= Date.now()) return null;
        let user;
        try {
            user = await firebase.auth().getUser(device.uid);
        } catch (error) {
            if ((error as { code?: string }).code === 'auth/user-not-found') return null;
            throw error;
        }
        if (user.disabled || !user.emailVerified || !user.email) return null;
        const validAfterMs = Date.parse(user.tokensValidAfterTime || '');
        if (!Number.isFinite(validAfterMs)) return null;
        if (isTrustedDeviceInvalidatedByCredentialChange(milliseconds(device.createdAt), validAfterMs)) {
            const state = await firebase.db().collection('auth_trusted_device_state').doc(device.uid).get();
            if (state.data()?.sessionOnlyValidAfterMs !== validAfterMs) return null;
        }
        return { email: user.email.toLowerCase(), expiresAt: milliseconds(device.expiresAt) };
    }

}

const readers = new WeakMap<FirebaseAdminService, TrustedBrowserStatusReader>();
// Read-only UI hint, never an authorization result. Actual sign-in stays fresh.
export function trustedBrowserStatus(firebase: FirebaseAdminService, request: Request, cookieName: string, emailValue?: unknown) {
    let reader = readers.get(firebase);
    if (!reader) { reader = new TrustedBrowserStatusReader(firebase); readers.set(firebase, reader); }
    return reader.check(request, cookieName, emailValue);
}
