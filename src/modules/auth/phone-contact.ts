import { BadRequestException } from '@nestjs/common';
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
export function phoneContact(profile: Profile) {
    const raw = typeof profile.phone === 'string' && profile.phone.trim() ? profile.phone.trim()
        : typeof profile.phoneNumber === 'string' ? profile.phoneNumber.trim() : '';
    return { phone: normalizeContactPhone(raw) || raw };
}
export async function saveContactProfile(firebase: FirebaseAdminService, email: string, updates: Profile, input?: unknown) {
    const ref = firebase.db().collection('users').doc(email);
    const phone = input === undefined
        ? undefined
        : typeof input === 'string' && !input.trim() ? null : normalizeContactPhone(input);
    if (phone === null && (typeof input !== 'string' || input.trim())) throw new BadRequestException('Enter a complete valid phone number.');
    await ref.set({
        ...updates,
        ...(phone !== undefined ? { phone, phoneNumber: FieldValue.delete() } : {}),
        phoneVerifiedAt: FieldValue.delete(),
        phoneVerifiedFor: FieldValue.delete(),
        phoneContactSchemaVersion: FieldValue.delete(),
        phoneMigrationConflict: FieldValue.delete(),
    }, { merge: true });
}
