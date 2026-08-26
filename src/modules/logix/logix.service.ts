import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import crypto from 'node:crypto';
import { DocumentData, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { Request, Response } from 'express';

export type LogLevel =
  | 'info'
  | 'warning'
  | 'error'
  | 'debug'
  | 'success'
  | 'audit'
  | 'metric';

export type LogEntry = {
  id: string;
  ts: string;
  level: LogLevel;
  type?: LogLevel;
  source: string;
  appName?: string;
  environment?: string;
  subsystem?: string | null;
  operation?: string | null;
  importance?: number | string | null;
  message: string;
  payload: Record<string, unknown>;
  durationMs?: number;
  ingested_at?: string;
};

export type IngestLogDto = {
  level?: LogLevel;
  type?: LogLevel;
  source?: string;
  appName?: string;
  environment?: string;
  subsystem?: string;
  operation?: string;
  importance?: number | string;
  message?: string;
  payload?: Record<string, unknown>;
  durationMs?: number;
  timestamp?: string;
};

export type QueryLogsDto = {
  type?: string;
  level?: string;
  env?: string;
  environment?: string;
  appName?: string;
  source?: string;
  search?: string;
  limit?: number | string;
  since?: string;
};

export type AlertDto = {
  name: string;
  condition: string;
  severity?: 'High' | 'Medium' | 'Low';
  channel?: 'Slack' | 'Email' | 'Webhook';
  thresholdPeriod?: '5m' | '15m' | '1h';
};

export type ProjectConfigDto = {
  name?: string;
  region?: string;
  timezone?: string;
};

const API_KEY_PREFIX = 'chf';
const MAX_KEYS_PER_USER = 5;

@Injectable()
export class LogixService {
  private readonly logger = new Logger(LogixService.name);

  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebaseAdmin: FirebaseAdminService,
  ) {}

  // ---------------------------------------------------------------------------
  // Firestore References
  // ---------------------------------------------------------------------------

  private userDoc(user: AuthenticatedUser) {
    const identifier = (user.email || user.uid || '').trim().toLowerCase();
    return this.firebaseAdmin.db().collection('users').doc(identifier);
  }

  private logsCollection(user: AuthenticatedUser) {
    return this.userDoc(user).collection('logixLogs');
  }

  private alertsCollection(user: AuthenticatedUser) {
    return this.userDoc(user).collection('logixAlerts');
  }

  private projectDoc(user: AuthenticatedUser) {
    return this.userDoc(user).collection('appProfiles').doc('logix');
  }

  private apiKeysCollection() {
    return this.firebaseAdmin.db().collection('api_keys');
  }

  // ---------------------------------------------------------------------------
  // Overview / Metrics (24h)
  // ---------------------------------------------------------------------------

  async getOverview(user: AuthenticatedUser) {
    const now = Date.now();
    const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000);

    const snapshot = await this.logsCollection(user)
      .where('createdAt', '>=', twentyFourHoursAgo)
      .orderBy('createdAt', 'desc')
      .limit(1000)
      .get();

    const logs = snapshot.docs.map(doc => this.toLogEntry(doc.id, doc.data()));
    const totalCount = logs.length;
    const errorCount = logs.filter(
      l => l.level === 'error' || l.type === 'error',
    ).length;
    const errorRate =
      totalCount > 0 ? ((errorCount / totalCount) * 100).toFixed(1) : '0.0';

    // 12-hour buckets
    const buckets = Array.from({ length: 12 }).map((_, i) => {
      const d = new Date(now - (11 - i) * 60 * 60 * 1000);
      const h = d.getHours();
      const nextH = (h + 1) % 24;

      const getPart = (hour: number) => {
        const ampm = hour >= 12 ? 'PM' : 'AM';
        const h12 = hour % 12 || 12;
        return { h12, ampm };
      };

      const start = getPart(h);
      const end = getPart(nextH);
      const label =
        start.ampm === end.ampm
          ? `${start.h12}-${end.h12} ${start.ampm}`
          : `${start.h12} ${start.ampm} - ${end.h12} ${end.ampm}`;

      return {
        hour: h,
        label,
        logs: 0,
        errors: 0,
      };
    });

    logs.forEach(log => {
      const date = new Date(log.ts);
      if (!Number.isNaN(date.getTime())) {
        const hour = date.getHours();
        const bucket = buckets.find(b => b.hour === hour);
        if (bucket) {
          bucket.logs += 1;
          if (log.level === 'error' || log.type === 'error') {
            bucket.errors += 1;
          }
        }
      }
    });

    // Top Sources
    const sourceCounts: Record<string, number> = {};
    logs.forEach(log => {
      const src = log.appName || log.source || 'default';
      sourceCounts[src] = (sourceCounts[src] || 0) + 1;
    });

    const topSources = Object.entries(sourceCounts)
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Top Activity (last 5)
    const topActivity = logs.slice(0, 5).map(log => {
      const date = new Date(log.ts);
      const time = !Number.isNaN(date.getTime())
        ? date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })
        : '—';

      let status = 'ok';
      if (log.level === 'error' || log.type === 'error') status = 'error';
      else if (log.level === 'warning') status = 'warn';

      return {
        time,
        source: log.subsystem || log.appName || log.source || 'unknown',
        action: log.operation || log.message || '-',
        status,
      };
    });

    const health = [
      { name: 'Ingest Service', status: 'healthy' },
      { name: 'Alerting Service', status: 'healthy' },
      { name: 'Database', status: 'healthy' },
      { name: 'Public API', status: 'healthy' },
    ];

    return {
      totalCount,
      errorRate: `${errorRate}%`,
      ingestRate: totalCount > 0 ? (totalCount / 86400).toFixed(2) : 0,
      avgLatency: 42,
      backlog: 0,
      lineData: buckets.map(b => ({ hour: b.label, logs: b.logs })),
      errorTrendData: buckets.map(b => ({ hour: b.label, errors: b.errors })),
      topSources,
      topActivity,
      health,
      logs,
    };
  }

  // ---------------------------------------------------------------------------
  // Logs Querying
  // ---------------------------------------------------------------------------

  async queryLogs(user: AuthenticatedUser, dto: QueryLogsDto) {
    const rawLimit = Number(dto.limit || 100);
    const safeLimit = Math.min(Math.max(rawLimit, 1), 500);

    let queryRef = this.logsCollection(user).orderBy('createdAt', 'desc');

    const filterType = (dto.type || dto.level || '').trim().toLowerCase();
    if (filterType && filterType !== 'all') {
      queryRef = queryRef.where('level', '==', filterType);
    }

    const filterEnv = (dto.env || dto.environment || '').trim().toLowerCase();
    if (filterEnv) {
      queryRef = queryRef.where('environment', '==', filterEnv);
    }

    const filterApp = (dto.appName || dto.source || '').trim().toLowerCase();
    if (filterApp) {
      queryRef = queryRef.where('appName', '==', filterApp);
    }

    const snapshot = await queryRef.limit(safeLimit).get();
    let logs = snapshot.docs.map(doc => this.toLogEntry(doc.id, doc.data()));

    // In-memory text search filtering if specified
    const searchTerm = (dto.search || '').trim().toLowerCase();
    if (searchTerm) {
      logs = logs.filter(l => {
        const text = `${l.message} ${l.source} ${l.appName} ${JSON.stringify(
          l.payload,
        )}`.toLowerCase();
        return text.includes(searchTerm);
      });
    }

    return {
      count: logs.length,
      logs,
    };
  }

  async streamLogs(
    user: AuthenticatedUser,
    dto: QueryLogsDto,
    request: Request,
    response: Response,
  ) {
    const safeLimit = Math.min(Math.max(Number(dto.limit || 500), 1), 5000);
    const filterType = (dto.type || dto.level || '').trim().toLowerCase();
    const filterEnv = (dto.env || dto.environment || '').trim().toLowerCase();
    const filterApp = (dto.appName || dto.source || '').trim().toLowerCase();
    const searchTerm = (dto.search || '').trim().toLowerCase();

    let query = this.logsCollection(user);
    if (filterType) query = query.where('level', '==', filterType) as typeof query;
    if (filterEnv) query = query.where('environment', '==', filterEnv) as typeof query;
    if (filterApp) query = query.where('appName', '==', filterApp) as typeof query;
    query = query.orderBy('createdAt', 'desc').limit(safeLimit) as typeof query;

    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders?.();

    const snapshot = await query.get();
    const initialIds = new Set(snapshot.docs.map(doc => doc.id));
    const initialLogs = snapshot.docs
      .map(doc => this.toLogEntry(doc.id, doc.data()))
      .filter(log => !searchTerm || `${log.message} ${log.source} ${log.appName} ${JSON.stringify(log.payload)}`.toLowerCase().includes(searchTerm))
      .reverse();
    response.write(`data: ${JSON.stringify({ type: 'initial_logs', logs: initialLogs })}\n\n`);

    const unsubscribe = query.onSnapshot(nextSnapshot => {
      const logs = nextSnapshot.docChanges()
        .filter(change => change.type === 'added' && !initialIds.has(change.doc.id))
        .map(change => this.toLogEntry(change.doc.id, change.doc.data()))
        .filter(log => !searchTerm || `${log.message} ${log.source} ${log.appName} ${JSON.stringify(log.payload)}`.toLowerCase().includes(searchTerm));
      if (logs.length > 0) response.write(`data: ${JSON.stringify({ type: 'live', logs })}\n\n`);
    }, error => {
      response.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
      response.end();
    });

    request.on('close', () => {
      unsubscribe();
      response.end();
    });
  }

  // ---------------------------------------------------------------------------
  // Log Ingestion
  // ---------------------------------------------------------------------------

  async ingestLog(user: AuthenticatedUser, dto: IngestLogDto) {
    const level: LogLevel = dto.level || dto.type || 'info';
    const message = String(dto.message || '').trim() || 'Log event recorded';
    const source = String(dto.source || dto.appName || 'default').trim();
    const appName = String(dto.appName || dto.source || 'default').trim();
    const environment = String(dto.environment || 'production').trim();
    const subsystem = dto.subsystem ? String(dto.subsystem).trim() : null;
    const operation = dto.operation ? String(dto.operation).trim() : null;
    const importance = dto.importance ?? null;
    const payload =
      dto.payload && typeof dto.payload === 'object' ? dto.payload : {};
    const durationMs =
      typeof dto.durationMs === 'number' ? dto.durationMs : null;

    const logId = `log_${crypto.randomBytes(8).toString('hex')}`;
    const timestamp = dto.timestamp ? new Date(dto.timestamp) : new Date();

    const data = {
      id: logId,
      level,
      type: level,
      message,
      source,
      appName,
      environment,
      subsystem,
      operation,
      importance,
      payload,
      durationMs,
      timestamp: timestamp.toISOString(),
      createdAt: FieldValue.serverTimestamp(),
    };

    await this.logsCollection(user).doc(logId).set(data);

    return {
      success: true,
      id: logId,
    };
  }

  // Ingest via raw API Key
  async ingestLogWithApiKey(rawKey: string, dto: IngestLogDto) {
    const apiKeyDoc = await this.verifyApiKey(rawKey);
    if (!apiKeyDoc) {
      throw new BadRequestException('Invalid or inactive API key.');
    }

    const ownerEmail = apiKeyDoc.ownerEmail || apiKeyDoc.userId;
    const ownerUid = apiKeyDoc.ownerUid || apiKeyDoc.userId;

    return this.ingestLog(
      { email: ownerEmail, uid: ownerUid } as AuthenticatedUser,
      dto,
    );
  }

  // ---------------------------------------------------------------------------
  // API Keys Management
  // ---------------------------------------------------------------------------

  async listApiKeys(user: AuthenticatedUser) {
    const userId = user.uid || user.email;

    const snapshot = await this.apiKeysCollection()
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .get();

    return snapshot.docs.map(doc => {
      const data = doc.data();
      const createdAt = this.serializeDate(data.createdAt);
      const lastUsedAt = this.serializeDate(data.lastUsedAt);

      return {
        id: doc.id,
        publicId: data.publicId || doc.id,
        name: data.name || 'Untitled key',
        scope: data.scope || 'Full Access',
        status: data.active ? 'Active' : 'Revoked',
        created: createdAt ? new Date(createdAt).toLocaleDateString() : '—',
        lastUsed: lastUsedAt
          ? new Date(lastUsedAt).toLocaleDateString()
          : 'Never',
        createdAt,
        lastUsedAt,
      };
    });
  }

  async createApiKey(
    user: AuthenticatedUser,
    body: {
      name?: string;
      scope?: 'Full Access' | 'Read Only' | 'Write Only';
      expiresAt?: string;
    },
  ) {
    const userId = user.uid || user.email;

    // Check count limit
    const countSnapshot = await this.apiKeysCollection()
      .where('userId', '==', userId)
      .where('active', '==', true)
      .count()
      .get();

    if (countSnapshot.data().count >= MAX_KEYS_PER_USER) {
      throw new BadRequestException(
        `You have reached the maximum limit of ${MAX_KEYS_PER_USER} active API keys.`,
      );
    }

    const { rawKey, keyHash, publicId } = await this.generateUniqueApiKey();

    const name = String(body.name || 'New Key').trim();
    const scope = body.scope || 'Full Access';

    await this.apiKeysCollection()
      .doc(publicId)
      .set({
        publicId,
        prefix: API_KEY_PREFIX,
        keyHash,
        name,
        scope,
        userId,
        ownerUid: user.uid,
        ownerEmail: user.email || '',
        active: true,
        status: 'Active',
        createdAt: FieldValue.serverTimestamp(),
        lastUsedAt: null,
        expiresAt: body.expiresAt || null,
      });

    return {
      key: rawKey,
      publicId,
      name,
      scope,
      status: 'Active',
    };
  }

  async revokeApiKey(user: AuthenticatedUser, keyId: string) {
    const normalizedId = String(keyId || '').trim();
    if (!normalizedId) throw new BadRequestException('Key ID is required.');

    const docRef = this.apiKeysCollection().doc(normalizedId);
    const doc = await docRef.get();

    const userId = user.uid || user.email;
    if (
      !doc.exists ||
      (doc.data()?.userId !== userId && doc.data()?.ownerUid !== user.uid)
    ) {
      throw new NotFoundException('API key not found.');
    }

    await docRef.update({
      active: false,
      status: 'Revoked',
      revokedAt: FieldValue.serverTimestamp(),
    });

    return { success: true };
  }

  async deleteApiKey(user: AuthenticatedUser, keyId: string) {
    const normalizedId = String(keyId || '').trim();
    if (!normalizedId) throw new BadRequestException('Key ID is required.');

    const docRef = this.apiKeysCollection().doc(normalizedId);
    const doc = await docRef.get();

    const userId = user.uid || user.email;
    if (
      !doc.exists ||
      (doc.data()?.userId !== userId && doc.data()?.ownerUid !== user.uid)
    ) {
      throw new NotFoundException('API key not found.');
    }

    await docRef.delete();

    return { success: true };
  }

  private async generateUniqueApiKey() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const publicId = crypto.randomBytes(8).toString('hex');
      const secret = crypto.randomBytes(24).toString('hex');
      const rawKey = `${API_KEY_PREFIX}_${publicId}_${secret}`;
      const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

      const existing = await this.apiKeysCollection().doc(publicId).get();
      if (!existing.exists) {
        return { rawKey, keyHash, publicId };
      }
    }

    throw new InternalServerErrorException('Failed to generate a unique API key.');
  }

  private async verifyApiKey(rawKey: string) {
    if (!rawKey.startsWith(`${API_KEY_PREFIX}_`)) return null;
    const parts = rawKey.split('_');
    if (parts.length < 3) return null;

    const publicId = parts[1];
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    const doc = await this.apiKeysCollection().doc(publicId).get();
    if (!doc.exists) return null;

    const data = doc.data();
    if (!data?.active || data.keyHash !== keyHash) return null;

    void doc.ref.update({ lastUsedAt: FieldValue.serverTimestamp() }).catch(() => {});
    return data;
  }

  // ---------------------------------------------------------------------------
  // Alerts Management
  // ---------------------------------------------------------------------------

  async listAlerts(user: AuthenticatedUser) {
    const snapshot = await this.alertsCollection(user)
      .orderBy('createdAt', 'desc')
      .get();

    return snapshot.docs.map(doc => {
      const data = doc.data();
      const lastTriggered = this.serializeDate(data.lastTriggered);

      return {
        id: doc.id,
        name: String(data.name || 'Untitled Alert'),
        condition: String(data.condition || 'error_rate > 5%'),
        status: (data.status || 'Active') as 'Active' | 'Resolved',
        severity: (data.severity || 'Medium') as 'High' | 'Medium' | 'Low',
        channel: data.channel || 'Slack',
        thresholdPeriod: data.thresholdPeriod || '15m',
        lastTriggered: lastTriggered
          ? new Date(lastTriggered).toLocaleString()
          : 'Never',
        createdAt: this.serializeDate(data.createdAt),
      };
    });
  }

  async createAlert(user: AuthenticatedUser, dto: AlertDto) {
    const name = String(dto.name || '').trim();
    if (!name) throw new BadRequestException('Alert name is required.');

    const condition = String(dto.condition || '').trim();
    if (!condition) throw new BadRequestException('Alert condition is required.');

    const alertId = `alt_${crypto.randomBytes(6).toString('hex')}`;

    const data = {
      id: alertId,
      name,
      condition,
      severity: dto.severity || 'Medium',
      channel: dto.channel || 'Slack',
      thresholdPeriod: dto.thresholdPeriod || '15m',
      status: 'Active',
      lastTriggered: null,
      createdAt: FieldValue.serverTimestamp(),
    };

    await this.alertsCollection(user).doc(alertId).set(data);

    return {
      success: true,
      alert: {
        ...data,
        createdAt: new Date().toISOString(),
      },
    };
  }

  async deleteAlert(user: AuthenticatedUser, alertId: string) {
    const id = String(alertId || '').trim();
    if (!id) throw new BadRequestException('Alert ID is required.');

    const docRef = this.alertsCollection(user).doc(id);
    const doc = await docRef.get();

    if (!doc.exists) {
      throw new NotFoundException('Alert not found.');
    }

    await docRef.delete();
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Project Settings & Billing
  // ---------------------------------------------------------------------------

  async getProjectSettings(user: AuthenticatedUser) {
    const doc = await this.projectDoc(user).get();
    const data = doc.data() || {};

    return {
      name: String(data.projectName || 'Default Project'),
      region: String(data.region || 'US-East-1 (N. Virginia)'),
      timezone: String(data.timezone || 'EST (UTC-5)'),
      plan: String(data.plan || 'free'),
      updatedAt: this.serializeDate(data.updatedAt),
    };
  }

  async updateProjectSettings(user: AuthenticatedUser, dto: ProjectConfigDto) {
    const updates: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (dto.name !== undefined) updates.projectName = dto.name.trim();
    if (dto.region !== undefined) updates.region = dto.region.trim();
    if (dto.timezone !== undefined) updates.timezone = dto.timezone.trim();

    await this.projectDoc(user).set(updates, { merge: true });

    return this.getProjectSettings(user);
  }

  async getBillingInfo(user: AuthenticatedUser) {
    const project = await this.getProjectSettings(user);

    return {
      plan: project.plan || 'free',
      invoices: [],
      usage: {
        logsLimit: '10k logs/month',
        retentionDays: 7,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Account Deletion
  // ---------------------------------------------------------------------------

  async requestAccountDeletion(user: AuthenticatedUser) {
    const now = new Date();
    const purgeDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    await this.userDoc(user).set(
      {
        accountStatus: 'pending_deletion',
        deletionRequestedAt: FieldValue.serverTimestamp(),
        scheduledPurgeAt: purgeDate.toISOString(),
      },
      { merge: true },
    );

    this.logger.warn(
      JSON.stringify({
        event: 'logix_account_deletion_requested',
        uid: user.uid,
        email: user.email,
        scheduledPurgeAt: purgeDate.toISOString(),
      }),
    );

    return {
      success: true,
      message:
        'Your account has been scheduled for permanent deletion in 14 days.',
      scheduledPurgeAt: purgeDate.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private toLogEntry(id: string, data: DocumentData): LogEntry {
    const ts =
      this.serializeDate(data.createdAt) ||
      this.serializeDate(data.timestamp) ||
      new Date().toISOString();

    const level: LogLevel = (data.level || data.type || 'info') as LogLevel;

    return {
      id,
      ts,
      level,
      type: level,
      source: String(data.source || data.appName || 'default'),
      appName: String(data.appName || data.source || 'default'),
      environment: String(data.environment || 'production'),
      subsystem: data.subsystem || null,
      operation: data.operation || null,
      importance: data.importance ?? null,
      message: String(data.message || ''),
      payload: (data.payload && typeof data.payload === 'object'
        ? data.payload
        : {}) as Record<string, unknown>,
      durationMs: data.durationMs || undefined,
      ingested_at: ts,
    };
  }

  private serializeDate(value: unknown): string | null {
    if (!value) return null;
    if (value instanceof Timestamp) return value.toDate().toISOString();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return value;
    if (
      typeof value === 'object' &&
      'toDate' in value &&
      typeof value.toDate === 'function'
    ) {
      return (value.toDate() as Date).toISOString();
    }
    return null;
  }
}
