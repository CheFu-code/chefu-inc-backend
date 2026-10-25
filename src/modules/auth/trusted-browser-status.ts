import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { isTrustedDeviceInvalidatedByCredentialChange } from './device-auth';

const milliseconds = (value: unknown): number => {
    if (!value || typeof value !== 'object' || !('toMillis' in value) || typeof value.toMillis !== 'function') return 0;
    return value.toMillis();
};

// UI hint only. Sign-in must still independently validate device ownership.
// The cookie is a random secret; never expose it, its hash, the UID or the
// owner's email. This check must not refresh expiry or update lastSeenAt.
export async function trustedBrowserStatus(
    firebase: FirebaseAdminService,
    request: Request,
    cookieName: string,
    emailValue?: unknown,
): Promise<{ trusted: boolean }> {
    if (emailValue !== undefined && (typeof emailValue !== 'string' || emailValue.length > 254)) return { trusted: false };
    const email = typeof emailValue === 'string' ? emailValue.trim().toLowerCase() : '';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { trusted: false };
    const token = request.cookies?.[cookieName];
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) return { trusted: false };

    const snapshot = await firebase.db().collection('auth_trusted_devices')
        .doc(createHash('sha256').update(token).digest('hex')).get();
    const device = snapshot.data();
    if (!snapshot.exists || typeof device?.uid !== 'string' || !device.uid || device.uid.includes('/') || device.revokedAt || milliseconds(device.expiresAt) <= Date.now()) return { trusted: false };
    let user;
    try {
        user = await firebase.auth().getUser(device.uid);
    } catch (error) {
        if ((error as { code?: string }).code === 'auth/user-not-found') return { trusted: false };
        throw error;
    }
    if (user.disabled || !user.emailVerified || !user.email || (email && user.email.toLowerCase() !== email)) return { trusted: false };
    const validAfterMs = Date.parse(user.tokensValidAfterTime || '');
    if (!Number.isFinite(validAfterMs)) return { trusted: false };
    if (isTrustedDeviceInvalidatedByCredentialChange(milliseconds(device.createdAt), validAfterMs)) {
        const state = await firebase.db().collection('auth_trusted_device_state').doc(device.uid).get();
        if (state.data()?.sessionOnlyValidAfterMs !== validAfterMs) return { trusted: false };
    }
    return { trusted: true };
}
