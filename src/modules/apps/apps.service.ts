import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import bcrypt from 'bcrypt';
import { randomBytes, randomUUID } from 'node:crypto';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { CHEFU_APPS, registeredAppOrigins, registeredOauthClients, resolveChefuAppId, resolveOauthClient } from './app-registry';
import type { ChefuApp, ChefuAppId, ChefuRegisteredAppRecord } from './app-registry.types';
import { validateRegistration, type RegistrationInput } from './app-validation';

type ManagedRecord = ChefuRegisteredAppRecord & { registry_version?: number; active_secret_version?: string };

@Injectable()
export class AppsService {
  constructor(@Inject(FirebaseAdminService) private readonly firebaseAdmin: FirebaseAdminService) {}

  list(): ChefuApp[] { return CHEFU_APPS; }
  origins() { return registeredAppOrigins(); }
  oauthClients() { return registeredOauthClients(); }

  async resolveId(value?: string): Promise<ChefuAppId | null> {
    const known = resolveChefuAppId(value);
    if (known || !value) return known;
    return (await this.policy(value))?.id || null;
  }

  async resolveOauthClient(clientId?: string) {
    if (!clientId) return null;
    return resolveOauthClient(clientId) || this.resolveDynamicOauthClient(clientId);
  }

  async getAppRecord(clientId: string): Promise<ManagedRecord | null> {
    this.validId(clientId);
    const snapshot = await this.firebaseAdmin.db().collection('oauth_apps').doc(clientId).get();
    return snapshot.exists ? snapshot.data() as ManagedRecord : null;
  }

  async listRegisteredApps() {
    const snapshot = await this.firebaseAdmin.db().collection('oauth_apps').orderBy('created_at', 'desc').limit(200).get();
    return { records: snapshot.docs.map(doc => {
      const record = doc.data() as ManagedRecord;
      return { client_id: doc.id, app_id: record.app_id || doc.id, name: record.name || doc.id, owner: record.owner || '', client_type: record.client_type, status: record.status, origins: Array.isArray(record.origins) ? record.origins : [], redirect_uris: Array.isArray(record.redirect_uris) ? record.redirect_uris : [], allowed_scopes: Array.isArray(record.allowed_scopes) ? record.allowed_scopes : [], created_at: record.created_at, registry_version: record.registry_version || 0 };
    }), limit: 200 };
  }

  async policy(appId: string) {
    const id = appId.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) return null;
    const known = CHEFU_APPS.find(app => app.id === id);
    if (known) return { ...known, clients: registeredOauthClients().filter(client => client.appId === id).map(client => ({ id: client.id, redirectUris: client.redirectUris, scopes: client.scopes })) };
    const snapshot = await this.firebaseAdmin.db().collection('oauth_apps').where('app_id', '==', id).limit(100).get();
    const records = snapshot.docs.map(doc => doc.data() as ManagedRecord).filter(record => record.registry_version === 1 && record.status === 'approved');
    if (!records.length) return null;
    return {
      id, name: records[0].name,
      origins: [...new Set(records.flatMap(record => record.origins || []))],
      clients: records.map(record => ({ id: record.client_id, redirectUris: record.redirect_uris, scopes: record.allowed_scopes })),
    };
  }

  async allowsOrigin(origin: string) {
    // One indexed query, not a scan of every registration. Static origins are
    // handled by HTTP middleware before reaching this fallback.
    const snapshot = await this.firebaseAdmin.db().collection('oauth_apps').where('origins', 'array-contains', origin).limit(100).get();
    return snapshot.docs.some(doc => { const record = doc.data(); return record.registry_version === 1 && record.status === 'approved'; });
  }

  async registerOauthClient(input: RegistrationInput, actor: string) {
    const data = validateRegistration(input);
    const clientId = data.clientId || `${data.appId.slice(0, 45)}-${randomBytes(6).toString('hex')}`;
    const type = data.clientType || 'public';
    const status = data.status || 'approved';
    const record: ManagedRecord = {
      client_id: clientId, app_id: data.appId, name: data.name, owner: data.owner,
      client_type: type, status, origins: data.origins, redirect_uris: data.redirectUris,
      allowed_scopes: data.allowedScopes, grant_types: ['authorization_code'],
      created_at: new Date().toISOString(), approved_by: actor,
      approved_at: status === 'approved' ? new Date().toISOString() : null, registry_version: 1,
    };
    const secret = type === 'confidential' ? await this.newSecret(clientId) : null;
    if (secret) record.active_secret_version = secret.version;
    const db = this.firebaseAdmin.db();
    const batch = db.batch();
    batch.create(db.collection('oauth_apps').doc(clientId), record);
    if (secret) batch.create(db.collection('oauth_app_secrets').doc(`${clientId}:${secret.version}`), secret.record);
    batch.create(db.collection('app_registry_audit').doc(), { actor, action: 'register', clientId, createdAt: new Date().toISOString() });
    try { await batch.commit(); }
    catch (error) { if ((error as { code?: number }).code === 6) throw new ConflictException('This client ID is already registered.'); throw error; }
    return { record, ...(secret ? { clientSecret: secret.secret } : {}) };
  }

  async approveOauthClient(clientId: string, actor: string) {
    const record = await this.required(clientId);
    validateRegistration({ appId: record.app_id || '', clientId, name: record.name, owner: record.owner, clientType: record.client_type, origins: record.origins || [], redirectUris: record.redirect_uris, allowedScopes: record.allowed_scopes });
    await this.changeStatus(clientId, 'approved', actor);
    return { client_id: clientId, status: 'approved' };
  }

  async revokeOauthClient(clientId: string, actor: string) {
    await this.required(clientId);
    await this.changeStatus(clientId, 'revoked', actor);
    return { client_id: clientId, status: 'revoked' };
  }

  private async changeStatus(clientId: string, status: 'approved' | 'revoked', actor: string) {
    const db = this.firebaseAdmin.db();
    const batch = db.batch();
    batch.update(db.collection('oauth_apps').doc(clientId), { status, approved_by: actor, approved_at: new Date().toISOString(), registry_version: 1 });
    batch.create(db.collection('app_registry_audit').doc(), { actor, action: status, clientId, createdAt: new Date().toISOString() });
    await batch.commit();
  }

  async rotateClientSecret(clientId: string, actor = 'system') {
    const app = await this.required(clientId);
    if (app.client_type !== 'confidential') throw new BadRequestException('Only confidential clients have a client secret.');
    const secret = await this.newSecret(clientId);
    const db = this.firebaseAdmin.db();
    const batch = db.batch();
    batch.create(db.collection('oauth_app_secrets').doc(`${clientId}:${secret.version}`), secret.record);
    batch.update(db.collection('oauth_apps').doc(clientId), { active_secret_version: secret.version });
    batch.create(db.collection('app_registry_audit').doc(), { actor, action: 'rotate-secret', clientId, createdAt: new Date().toISOString() });
    await batch.commit();
    return { client_id: clientId, secret: secret.secret, secret_version: secret.version };
  }

  async verifyClientSecret(clientId: string, secret: string) {
    const app = await this.getAppRecord(clientId);
    if (app?.active_secret_version) {
      const active = await this.firebaseAdmin.db().collection('oauth_app_secrets').doc(`${clientId}:${app.active_secret_version}`).get();
      return active.exists && bcrypt.compare(secret, active.data()!.secret_hash);
    }
    const snapshot = await this.firebaseAdmin.db().collection('oauth_app_secrets').where('client_id', '==', clientId).orderBy('created_at', 'desc').limit(1).get();
    return !snapshot.empty && bcrypt.compare(secret, snapshot.docs[0].data().secret_hash);
  }

  async isConfidentialClient(clientId: string) { return (await this.getAppRecord(clientId))?.client_type === 'confidential'; }

  async resolveDynamicOauthClient(clientId: string) {
    const record = await this.getAppRecord(clientId);
    if (!record || record.status !== 'approved' || record.registry_version !== 1 || !record.app_id) return null;
    return { id: record.client_id, appId: record.app_id, name: record.name, redirectUris: record.redirect_uris, scopes: record.allowed_scopes };
  }

  private async required(clientId: string) {
    if (resolveOauthClient(clientId)) throw new BadRequestException('Built-in clients are managed by the platform configuration.');
    const record = await this.getAppRecord(clientId);
    if (!record) throw new NotFoundException('Application not found.');
    return record;
  }
  private validId(value: string) { if (!/^[a-zA-Z0-9_-]{2,128}$/.test(value)) throw new BadRequestException('Invalid client ID.'); }
  private async newSecret(clientId: string) {
    const secret = `chefu_${randomBytes(32).toString('hex')}`;
    const version = `${Date.now()}-${randomUUID()}`;
    return { secret, version, record: { client_id: clientId, app_id: clientId, secret_hash: await bcrypt.hash(secret, 12), secret_version: version, expires_at: null, created_at: new Date().toISOString(), rotated_at: new Date().toISOString() } };
  }
}
