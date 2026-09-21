import { Injectable } from '@nestjs/common';
import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import {
  CHEFU_APPS,
  ChefuApp,
  ChefuAppId,
  ChefuAppSecretRecord,
  ChefuOauthClient,
  ChefuRegisteredAppRecord,
  mapAppRecordToOauthClient,
  registeredAppOrigins,
  registeredOauthClients,
  resolveChefuAppId,
  resolveOauthClient,
} from './app-registry';

@Injectable()
export class AppsService {
  constructor(
    private readonly firebaseAdmin: FirebaseAdminService,
  ) {}

  list(): ChefuApp[] {
    return CHEFU_APPS;
  }

  origins() {
    return registeredAppOrigins();
  }

  resolveId(value?: string): ChefuAppId | null {
    return resolveChefuAppId(value);
  }

  oauthClients(): ChefuOauthClient[] {
    return registeredOauthClients();
  }

  resolveOauthClient(clientId?: string): ChefuOauthClient | null {
    if (!clientId) return null;

    const staticClient = resolveOauthClient(clientId);
    if (staticClient) return staticClient;

    return null;
  }

  async getAppRecord(clientId: string): Promise<ChefuRegisteredAppRecord | null> {
    const snapshot = await this.firebaseAdmin.db().collection('oauth_apps').doc(clientId).get();
    if (!snapshot.exists) return null;
    return snapshot.data() as ChefuRegisteredAppRecord | null;
  }

  async listRegisteredApps() {
    const snapshot = await this.firebaseAdmin.db().collection('oauth_apps').get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  async registerOauthClient(input: {
    appId: string;
    clientId?: string;
    name: string;
    owner: string;
    redirectUris: string[];
    allowedScopes: string[];
    grantTypes?: string[];
    clientType?: 'public' | 'confidential';
    status?: 'pending' | 'approved' | 'revoked';
    clientSecret?: string;
  }) {
    const normalizedClientId = input.clientId || this.generateClientId(input.name);
    const clientType = input.clientType || 'public';
    const record: ChefuRegisteredAppRecord = {
      client_id: normalizedClientId,
      app_id: input.appId.trim(),
      name: input.name,
      owner: input.owner,
      client_type: clientType,
      status: input.status || 'pending',
      redirect_uris: input.redirectUris,
      allowed_scopes: input.allowedScopes,
      grant_types: input.grantTypes || ['authorization_code'],
      created_at: new Date().toISOString(),
      approved_by: null,
      approved_at: null,
    };

    await this.firebaseAdmin.db()
      .collection('oauth_apps')
      .doc(normalizedClientId)
      .set(record, { merge: true });

    const secretResult = clientType === 'confidential'
      ? await this.rotateClientSecret(normalizedClientId, input.clientSecret)
      : null;

    return {
      record,
      ...(secretResult ? { clientSecret: secretResult.secret, secret_version: secretResult.secret_version } : {}),
    };
  }

  async approveOauthClient(clientId: string, approvedBy: string) {
    const ref = this.firebaseAdmin.db().collection('oauth_apps').doc(clientId);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      throw new Error(`OAuth app ${clientId} does not exist.`);
    }

    const app = snapshot.data() as ChefuRegisteredAppRecord;
    await ref.set({
      status: 'approved',
      approved_by: approvedBy,
      approved_at: new Date().toISOString(),
    }, { merge: true });

    if (app.client_type === 'confidential') {
      const secret = await this.rotateClientSecret(clientId);
      return { client_id: clientId, status: 'approved', approved_by: approvedBy, clientSecret: secret.secret, secret_version: secret.secret_version };
    }

    return { client_id: clientId, status: 'approved', approved_by: approvedBy };
  }

  async revokeOauthClient(clientId: string, approvedBy: string) {
    const ref = this.firebaseAdmin.db().collection('oauth_apps').doc(clientId);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      throw new Error(`OAuth app ${clientId} does not exist.`);
    }

    await ref.set({
      status: 'revoked',
      approved_by: approvedBy,
      approved_at: new Date().toISOString(),
    }, { merge: true });

    return { client_id: clientId, status: 'revoked', approved_by: approvedBy };
  }

  async rotateClientSecret(clientId: string, providedSecret?: string) {
    const app = await this.getAppRecord(clientId);
    if (!app) {
      throw new Error(`OAuth app ${clientId} does not exist.`);
    }

    if (app.client_type !== 'confidential') {
      throw new Error(`Client ${clientId} is not a confidential OAuth client.`);
    }

    const secret = providedSecret || this.generateClientSecret();
    const version = `v${Date.now()}`;
    const hashed = await this.hashSecret(secret);
    const secretRecord: ChefuAppSecretRecord = {
      app_id: app.client_id,
      client_id: clientId,
      secret_hash: hashed,
      secret_version: version,
      expires_at: null,
      rotated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    await this.firebaseAdmin.db().collection('oauth_app_secrets').doc(`${clientId}:${version}`).set(secretRecord);
    return { client_id: clientId, secret_version: version, secret };
  }

  async verifyClientSecret(clientId: string, secret: string) {
    const snapshot = await this.firebaseAdmin.db()
      .collection('oauth_app_secrets')
      .where('client_id', '==', clientId)
      .orderBy('created_at', 'desc')
      .limit(1)
      .get();

    if (snapshot.empty) return false;

    const record = snapshot.docs[0].data() as ChefuAppSecretRecord;
    return bcrypt.compare(secret, record.secret_hash);
  }

  async isConfidentialClient(clientId: string) {
    const dynamicRecord = await this.getAppRecord(clientId);
    return dynamicRecord?.client_type === 'confidential';
  }

  async resolveDynamicOauthClient(clientId: string): Promise<ChefuOauthClient | null> {
    const snapshot = await this.firebaseAdmin.db().collection('oauth_apps').doc(clientId).get();
    if (!snapshot.exists) return null;

    const record = snapshot.data() as ChefuRegisteredAppRecord | undefined;
    if (!record || record.status !== 'approved') return null;
    return mapAppRecordToOauthClient(record);
  }

  private async hashSecret(secret: string) {
    return bcrypt.hash(secret, 12);
  }

  private generateClientSecret() {
    return `chefu_${randomBytes(24).toString('hex')}`;
  }

  private generateClientId(name: string) {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    const suffix = Math.random().toString(36).slice(2, 10);
    return `${slug || 'chefu-app'}-${suffix}`;
  }
}
