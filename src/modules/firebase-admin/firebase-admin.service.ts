import { Injectable, Logger } from '@nestjs/common';
import admin from 'firebase-admin';

@Injectable()
export class FirebaseAdminService {
  private readonly logger = new Logger(FirebaseAdminService.name);
  private app?: admin.app.App;
  private serviceAccountProjectId?: string;

  getApp() {
    if (this.app) return this.app;

    const serviceAccount = this.resolveServiceAccount();
    this.serviceAccountProjectId = serviceAccount.projectId;

    this.app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined,
        });

    this.logger.log(
      JSON.stringify({
        event: 'firebase_admin_initialized',
        existingAppReused: admin.apps.length > 1,
        projectId: serviceAccount.projectId || null,
      }),
    );

    return this.app;
  }

  auth(): admin.auth.Auth {
    return admin.auth(this.getApp());
  }

  db(): admin.firestore.Firestore {
    return admin.firestore(this.getApp());
  }

  messaging(): admin.messaging.Messaging {
    return admin.messaging(this.getApp());
  }

  storageBucket() {
    const configuredBucket = process.env.FIREBASE_STORAGE_BUCKET?.trim();
    const storage = admin.storage(this.getApp());

    return configuredBucket
      ? storage.bucket(configuredBucket)
      : storage.bucket();
  }

  projectId() {
    this.getApp();
    return this.serviceAccountProjectId || null;
  }

  private resolveServiceAccount(): admin.ServiceAccount {
    const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (rawServiceAccount) {
      const parsed = JSON.parse(rawServiceAccount) as Record<string, unknown>;

      // Some deploy systems provide the service account JSON with
      // escaped newlines in the private key ("\\n"). Normalize that
      // so firebase-admin can parse the PEM correctly.
      if (typeof parsed.private_key === 'string') {
        parsed.private_key = (parsed.private_key as string).replace(/\\n/g, '\n');
      }

      // Normalize common JSON key names to the shape admin SDK expects.
      if (!parsed.projectId && parsed.project_id) {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        parsed.projectId = parsed.project_id;
      }

      if (!parsed.clientEmail && parsed.client_email) {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        parsed.clientEmail = parsed.client_email;
      }

      return parsed as admin.ServiceAccount;
    }

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error('Firebase Admin credentials are not configured.');
    }

    return {
      projectId,
      clientEmail,
      privateKey,
    };
  }
}
