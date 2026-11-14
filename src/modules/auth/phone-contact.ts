import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { isPhoneNumber } from 'class-validator';
import { FieldValue } from 'firebase-admin/firestore';
import type { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

type Profile = Record<string, unknown>;
export function normalizeContactPhone(input: unknown): string | null {
    if (typeof input !== 'string' || input.length > 32 || !/^\+?[\d\s()-]+$/.test(input)) return null;
    const cleaned = input.replace(/[\s()-]/g, '');
    const phone = /^0[1-9]\d{8}$/.test(cleaned) ? `+27${cleaned.slice(1)}` : cleaned;
    return /^\+[1-9]\d{7,14}$/.test(phone) && isPhoneNumber(phone) ? phone : null;
}
function dateIso(value: unknown): string | null {
    const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value)
        : value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function' ? value.toDate() : null;
    return date instanceof Date && Number.isFinite(date.getTime()) && date.getTime() <= Date.now() ? date.toISOString() : null;
}
export function phoneContact(profile: Profile) {
    const raw = typeof profile.phone === 'string' && profile.phone.trim() ? profile.phone.trim()
        : typeof profile.phoneNumber === 'string' ? profile.phoneNumber.trim() : '';
    const phone = normalizeContactPhone(raw) || raw;
    const verifiedAt = dateIso(profile.phoneVerifiedAt);
    const alias = typeof profile.phoneNumber === 'string' ? profile.phoneNumber.trim() : '';
    const conflict = !!alias && !!profile.phone && (normalizeContactPhone(alias) || alias) !== phone;
    const verified = !conflict && !!phone && !!normalizeContactPhone(phone) && profile.phoneVerifiedFor === phone && !!verifiedAt;
    return {
        phone, phoneVerifiedAt: verified ? verifiedAt : null,
        phoneVerifiedFor: verified ? phone : null, phoneVerificationRequired: !!raw && !verified
    };
}
export function assertPhoneVerified(profile: Profile) {
    if (phoneContact(profile).phoneVerificationRequired) throw new ForbiddenException({
        message: 'Verify your phone number before continuing.', code: 'phone_verification_required', phoneVerificationRequired: true,
    });
}
// Central account management, sign-out and OTP endpoints remain accessible so
// pending users can repair a number, verify it, or leave the account safely.
export function isPhoneRecoveryRequest(path = '') {
    return /^\/phone-verification\/(send|check|status)\/?$/.test(path)
        || /^\/auth(?:\/|$)/.test(path) && !/^\/auth\/shopyethu(?:\/|$)/.test(path);
}
export async function saveContactProfile(firebase: FirebaseAdminService, email: string, updates: Profile, input?: unknown) {
    const ref = firebase.db().collection('users').doc(email);
    if (input === undefined) { await ref.set(updates, { merge: true }); return; }
    const phone = typeof input === 'string' && !input.trim() ? null : normalizeContactPhone(input);
    if (phone === null && (typeof input !== 'string' || input.trim())) throw new BadRequestException('Enter a complete valid phone number.');
    await firebase.db().runTransaction(async tx => {
        const current = phoneContact((await tx.get(ref)).data() || {});
        if (!phone && current.phoneVerificationRequired) throw new ForbiddenException('Verify or replace your existing phone number before removing it.');
        const same = phone === current.phone;
        tx.set(ref, {
            ...updates, phone, phoneNumber: FieldValue.delete(),
            phoneContactSchemaVersion: 1, phoneMigrationConflict: false,
            phoneVerifiedAt: same ? current.phoneVerifiedAt : null,
            phoneVerifiedFor: same ? current.phoneVerifiedFor : null,
        }, { merge: true });
    });
}
