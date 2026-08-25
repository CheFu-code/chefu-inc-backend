import { BadRequestException, Injectable } from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import {
  defaultNotificationPreferences,
  notificationPreferenceKeys,
  normalizeNotificationPreferences,
  sanitizePreferencePatch,
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

    const current = await this.getPreferences(user);
    const preferences = {
      ...current.preferences,
      ...patch,
    };

    await this.userRef(user).set(
      {
        emailPreferences: preferences,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      preferences,
      defaults: defaultNotificationPreferences,
      available: notificationPreferenceKeys,
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
