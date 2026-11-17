import { BadRequestException, Injectable } from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import {
  defaultShopYethuNotificationPreferences,
  defaultNotificationPreferences,
  notificationPreferenceKeys,
  normalizeShopYethuNotificationPreferences,
  normalizeNotificationPreferences,
  sanitizeShopYethuPreferencePatch,
  sanitizePreferencePatch,
  shopYethuNotificationPreferenceKeys,
} from './notification-preferences';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly firebaseAdmin: FirebaseAdminService,
  ) {}

  async getPreferences(user: AuthenticatedUser) {
    const userDoc = await this.getUserDoc(user);
    const data = userDoc.exists ? userDoc.data() : {};

    return {
      preferences: normalizeNotificationPreferences(data?.emailPreferences),
      defaults: defaultNotificationPreferences,
      available: notificationPreferenceKeys,
    };
  }

  async updatePreferences(user: AuthenticatedUser, input: unknown) {
    const patch = sanitizePreferencePatch(input);
    if (!Object.keys(patch).length) {
      throw new BadRequestException('At least one valid preference is required.');
    }

    const ref = this.userRef(user);
    const preferences = await this.firebaseAdmin.db().runTransaction(async transaction => {
      const current = normalizeNotificationPreferences((await transaction.get(ref)).data()?.emailPreferences);
      const preferences = { ...current, ...patch };
      if (notificationPreferenceKeys.some(key => current[key] !== preferences[key])) {
        transaction.set(ref, {
          emailPreferences: preferences,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      return preferences;
    });

    return {
      preferences,
      defaults: defaultNotificationPreferences,
      available: notificationPreferenceKeys,
    };
  }

  async getShopYethuPreferences(user: AuthenticatedUser) {
    const userDoc = await this.getUserDoc(user);
    const data = userDoc.exists ? userDoc.data() : {};
    const stored = data?.shopYethuNotificationPreferences;
    const configured =
      typeof stored === 'object' &&
      stored !== null &&
      !Array.isArray(stored) &&
      shopYethuNotificationPreferenceKeys.some(
        key => typeof (stored as Record<string, unknown>)[key] === 'boolean',
      );

    return {
      preferences: normalizeShopYethuNotificationPreferences(stored),
      defaults: defaultShopYethuNotificationPreferences,
      available: shopYethuNotificationPreferenceKeys,
      configured,
    };
  }

  async updateShopYethuPreferences(user: AuthenticatedUser, input: unknown) {
    const patch = sanitizeShopYethuPreferencePatch(input);
    if (!Object.keys(patch).length) {
      throw new BadRequestException('At least one valid preference is required.');
    }

    const ref = this.userRef(user);
    const preferences = await this.firebaseAdmin.db().runTransaction(async transaction => {
      const current = normalizeShopYethuNotificationPreferences(
        (await transaction.get(ref)).data()?.shopYethuNotificationPreferences,
      );
      const preferences = { ...current, ...patch };
      if (shopYethuNotificationPreferenceKeys.some(key => current[key] !== preferences[key])) {
        transaction.set(ref, {
          shopYethuNotificationPreferences: preferences,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      return preferences;
    });

    return {
      preferences,
      defaults: defaultShopYethuNotificationPreferences,
      available: shopYethuNotificationPreferenceKeys,
      configured: true,
    };
  }

  private userRef(user: AuthenticatedUser) {
    if (!user.email) {
      throw new BadRequestException('Authenticated user email is required.');
    }

    return this.firebaseAdmin.db().collection('users').doc(user.email);
  }

  private getUserDoc(user: AuthenticatedUser) {
    return this.userRef(user).get();
  }
}
