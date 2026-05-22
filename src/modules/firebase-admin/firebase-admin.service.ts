import { Injectable } from '@nestjs/common';
import admin from 'firebase-admin';

@Injectable()
export class FirebaseAdminService {
  private app?: admin.app.App;

  getApp() {
    if (this.app) return this.app;

    const serviceAccount = this.resolveServiceAccount();

    this.app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });

    return this.app;
  }

  auth() {
    return admin.auth(this.getApp());
  }

  db() {
    return admin.firestore(this.getApp());
  }

  private resolveServiceAccount(): admin.ServiceAccount {
    const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (rawServiceAccount) {
      return JSON.parse(rawServiceAccount) as admin.ServiceAccount;
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
