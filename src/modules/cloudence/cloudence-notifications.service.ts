import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { FirebaseAdminService } from "../firebase-admin/firebase-admin.service";

const DEVICE_COLLECTION = "cloudence_push_devices";
const PREFERENCE_COLLECTION = "cloudence_notification_preferences";
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_EXPO_MESSAGES = 100;

type AlertKind = "quota" | "collaborator";
type PushPreferences = {
  quotaAlertsEnabled?: boolean;
  collaboratorActivityEnabled?: boolean;
};

@Injectable()
export class CloudenceNotificationsService {
  private readonly logger = new Logger(CloudenceNotificationsService.name);

  constructor(private readonly firebase: FirebaseAdminService) {}

  async registerDevice(userId: string, token: string, platform: string) {
    const tokenId = createHash("sha256").update(token).digest("hex");
    await this.firebase.db().collection(DEVICE_COLLECTION).doc(tokenId).set({
      userId,
      token,
      platform,
      updatedAt: new Date().toISOString(),
    });
    return { registered: true };
  }

  async removeDevice(userId: string, token: string) {
    const tokenId = createHash("sha256").update(token).digest("hex");
    const ref = this.firebase.db().collection(DEVICE_COLLECTION).doc(tokenId);
    const snapshot = await ref.get();
    if (snapshot.exists && snapshot.data()?.userId === userId)
      await ref.delete();
    return { removed: true };
  }

  async updatePreferences(userId: string, preferences: PushPreferences) {
    await this.firebase
      .db()
      .collection(PREFERENCE_COLLECTION)
      .doc(userId)
      .set(
        { ...preferences, updatedAt: new Date().toISOString() },
        { merge: true },
      );
    return { saved: true };
  }

  async getPreferences(userId: string) {
    const preferences = (
      await this.firebase
        .db()
        .collection(PREFERENCE_COLLECTION)
        .doc(userId)
        .get()
    ).data();
    return {
      quotaAlertsEnabled: preferences?.quotaAlertsEnabled !== false,
      collaboratorActivityEnabled:
        preferences?.collaboratorActivityEnabled !== false,
    };
  }

  async notifyQuotaReached(userId: string, percentage: number) {
    await this.sendToUser(userId, "quota", {
      title: "Storage almost full",
      body: `${Math.round(percentage)}% of your Cloudence storage is in use.`,
      data: { url: "/(tabs)/profile", type: "quota" },
    });
  }

  async notifyCollaboratorAccessChanged(
    emails: string[],
    fileName: string,
    granted: boolean,
  ) {
    await Promise.all(
      emails.map(async (email) => {
        try {
          const account = await this.firebase.auth().getUserByEmail(email);
          await this.sendToUser(account.uid, "collaborator", {
            title: granted ? "File access granted" : "File access removed",
            body: granted
              ? `You can now access ${fileName} in Cloudence.`
              : `Your access to ${fileName} was removed.`,
            data: { url: "/shared-access", type: "collaborator" },
          });
        } catch {
          // The invited email may not have a Cloudence account or push-enabled device.
        }
      }),
    );
  }

  private async sendToUser(
    userId: string,
    kind: AlertKind,
    notification: { title: string; body: string; data: Record<string, string> },
  ) {
    try {
      const db = this.firebase.db();
      const preference = (
        await db.collection(PREFERENCE_COLLECTION).doc(userId).get()
      ).data();
      const enabled =
        kind === "quota"
          ? preference?.quotaAlertsEnabled !== false
          : preference?.collaboratorActivityEnabled !== false;
      if (!enabled) return;

      const devices = await db
        .collection(DEVICE_COLLECTION)
        .where("userId", "==", userId)
        .get();
      const tokens = devices.docs
        .map((device) => device.data()?.token)
        .filter(
          (token): token is string =>
            typeof token === "string" && token.length > 0,
        );
      for (let start = 0; start < tokens.length; start += MAX_EXPO_MESSAGES) {
        const messages = tokens
          .slice(start, start + MAX_EXPO_MESSAGES)
          .map((to) => ({
            to,
            sound: "default",
            title: notification.title,
            body: notification.body,
            data: notification.data,
            channelId: "cloudence-alerts",
          }));
        const response = await fetch(EXPO_PUSH_URL, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Accept-encoding": "gzip, deflate",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(messages),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
          this.logger.warn(
            `Expo push request failed with status ${response.status}.`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `Cloudence push notification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
