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
      let parsed: Record<string, unknown> | null = null;

      // Try plain JSON parse first
      try {
        parsed = JSON.parse(rawServiceAccount) as Record<string, unknown>;
      } catch (err) {
        // If parsing fails, try base64 decode then parse (common in container envs)
        try {
          const decoded = Buffer.from(rawServiceAccount, 'base64').toString('utf8');
          parsed = JSON.parse(decoded) as Record<string, unknown>;
        } catch (err2) {
          throw new Error(
            'Failed to parse FIREBASE_SERVICE_ACCOUNT: not valid JSON or base64-encoded JSON.',
          );
        }
      }

      // Normalize private key newlines — handle single- and double-escaped sequences
      if (typeof parsed.private_key === 'string') {
        let pk = parsed.private_key as string;
        // Remove surrounding quotes if present
        if (pk.startsWith('"') && pk.endsWith('"')) {
          pk = pk.slice(1, -1);
        }
        pk = pk.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n');
        parsed.private_key = pk;
      }

      // Also accept alternative key names used by different formats
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

      // Validate private key looks like a PEM
      if (typeof parsed.private_key === 'string') {
        const key = parsed.private_key as string;
        if (!key.includes('BEGIN') || !key.includes('PRIVATE KEY')) {
          throw new Error(
            'FIREBASE_SERVICE_ACCOUNT.private_key appears malformed; ensure newlines are correctly encoded (\\n) and the key includes PEM headers.',
          );
        }
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
