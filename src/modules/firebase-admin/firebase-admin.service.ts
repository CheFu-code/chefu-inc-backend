import { Injectable, Logger } from '@nestjs/common';
import admin from 'firebase-admin';

function normalizePrivateKey(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let key = raw.trim();

  // If the whole key is base64 encoded without PEM markers, try base64 decoding it
  if (!key.includes('BEGIN') && /^[A-Za-z0-9+/=\r\n]+$/.test(key) && key.length > 64) {
    try {
      const decoded = Buffer.from(key, 'base64').toString('utf8');
      if (decoded.includes('BEGIN')) {
        key = decoded.trim();
      }
    } catch {
      // keep original string
    }
  }

  // Remove surrounding quotes if present
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }

  // Replace all literal escaped newline variants: \\n, \n, \r\n, etc.
  key = key
    .replace(/\\\\r\\\\n/g, '\n')
    .replace(/\\\\n/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  // Normalize standard OpenSSL PEM format (header, 64-char chunked base64 body, footer)
  const pemMatch = key.match(
    /(-----BEGIN[ A-Z0-9_-]+-----)([\s\S]+?)(-----END[ A-Z0-9_-]+-----)/i,
  );
  if (pemMatch) {
    const header = pemMatch[1].trim();
    const rawBody = pemMatch[2].replace(/\s+/g, '');
    const footer = pemMatch[3].trim();

    const formattedBody = rawBody.match(/.{1,64}/g)?.join('\n') || rawBody;
    return `${header}\n${formattedBody}\n${footer}\n`;
  }

  return key;
}

@Injectable()
export class FirebaseAdminService {
  private readonly logger = new Logger(FirebaseAdminService.name);
  private app?: admin.app.App;
  private firestoreInstance?: admin.firestore.Firestore;
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
    if (!this.firestoreInstance) {
      this.firestoreInstance = admin.firestore(this.getApp());
      // Allow undefined field values to be silently omitted rather than
      // throwing "Cannot use undefined as a Firestore value".
      this.firestoreInstance.settings({ ignoreUndefinedProperties: true });
    }
    return this.firestoreInstance;
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
        // If parsing fails, try base64 decode then parse
        try {
          const decoded = Buffer.from(rawServiceAccount, 'base64').toString('utf8');
          parsed = JSON.parse(decoded) as Record<string, unknown>;
        } catch (err2) {
          throw new Error(
            'Failed to parse FIREBASE_SERVICE_ACCOUNT: not valid JSON or base64-encoded JSON.',
          );
        }
      }

      const rawPrivateKey =
        parsed.private_key || parsed.privateKey || parsed.private_key_id;
      const privateKey = normalizePrivateKey(rawPrivateKey);

      const projectId = String(
        parsed.projectId || parsed.project_id || process.env.FIREBASE_PROJECT_ID || '',
      );
      const clientEmail = String(
        parsed.clientEmail || parsed.client_email || process.env.FIREBASE_CLIENT_EMAIL || '',
      );

      if (!privateKey || !privateKey.includes('BEGIN') || !privateKey.includes('PRIVATE KEY')) {
        throw new Error(
          'FIREBASE_SERVICE_ACCOUNT.private_key appears malformed; ensure it contains valid PEM headers (-----BEGIN PRIVATE KEY-----).',
        );
      }

      return {
        projectId,
        clientEmail,
        privateKey,
      };
    }

    const projectId =
      process.env.FIREBASE_PROJECT_ID ||
      process.env.FIREBASE_ADMIN_PROJECT_ID;
    const clientEmail =
      process.env.FIREBASE_CLIENT_EMAIL ||
      process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
    const rawPrivateKey =
      process.env.FIREBASE_PRIVATE_KEY ||
      process.env.FIREBASE_ADMIN_PRIVATE_KEY;

    const privateKey = normalizePrivateKey(rawPrivateKey);

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
