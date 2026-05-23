import { BadRequestException, Injectable } from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { ResendService } from '../email/resend.service';
import {
  NotificationPreferenceKey,
  defaultNotificationPreferences,
  notificationPreferenceKeys,
  normalizeNotificationPreferences,
  sanitizePreferencePatch,
} from './notification-preferences';

type SendNotificationInput = {
  type?: string;
  subject?: string;
  title?: string;
  message?: string;
  actionLabel?: string;
  actionUrl?: string;
};

@Injectable()
export class NotificationsService {
  constructor(
    private readonly firebaseAdmin: FirebaseAdminService,
    private readonly resendService: ResendService,
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

  async sendPreferenceEmail(
    user: AuthenticatedUser,
    input: SendNotificationInput,
  ) {
    const type = (input.type || 'general') as NotificationPreferenceKey;
    if (!notificationPreferenceKeys.includes(type)) {
      throw new BadRequestException('Invalid notification type.');
    }

    if (!input.subject || !input.title || !input.message) {
      throw new BadRequestException('Subject, title, and message are required.');
    }

    const userDoc = await this.getUserDoc(user);
    const data = userDoc.exists ? userDoc.data() : {};
    const preferences = normalizeNotificationPreferences(data?.emailPreferences);

    if (preferences[type] === false) {
      return {
        sent: false,
        skipped: true,
        reason: `User disabled ${type} emails.`,
        preferences,
      };
    }

    await this.resendService.sendPreferenceNotification({
      email: user.email,
      type,
      subject: input.subject,
      title: input.title,
      message: input.message,
      userName:
        typeof data?.fullname === 'string'
          ? data.fullname
          : user.email.split('@')[0],
      actionLabel: input.actionLabel,
      actionUrl: input.actionUrl,
    });

    return {
      sent: true,
      skipped: false,
      preferences,
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
