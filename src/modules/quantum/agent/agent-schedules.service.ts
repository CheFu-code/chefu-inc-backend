import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { FirebaseAdminService } from '../../firebase-admin/firebase-admin.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { QuantumAgentDataService } from './agent-data.service';
import { identifier, metadata, text } from './agent-validation';
import { nextRunAt, ScheduleRule } from './schedule-time';

type ScheduleInput = {
  title?: unknown; originalPrompt?: unknown; taskPayload?: unknown;
  scheduleRule: ScheduleRule; timezone?: unknown; delivery?: unknown; sourceThreadId?: unknown;
};
type StoredSchedule = {
  id: string; user_id: string; user_email: string; title: string; original_prompt: string;
  task_payload: Record<string, unknown>; schedule_rule: ScheduleRule; timezone: string; delivery: string;
  source_thread_id: string | null; status: string; next_run_at: string; lease_until?: number; run_id?: string;
};

@Injectable()
export class QuantumAgentSchedulesService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private readonly logger = new Logger(QuantumAgentSchedulesService.name);
  constructor(
    @Inject(FirebaseAdminService) private readonly firebase: FirebaseAdminService,
    @Inject(QuantumAgentDataService) private readonly data: QuantumAgentDataService,
  ) {}
  private collection() { return this.firebase.db().collection('quantum_agent_schedules'); }
  onModuleInit() {
    if (!process.env.QUANTUM_AGENT_WORKER_URL || !process.env.QUANTUM_AGENT_WORKER_SECRET) return;
    this.timer = setInterval(() => { void this.tick(); }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  async list(user: AuthenticatedUser) {
    const rows = await this.collection().where('user_id', '==', user.uid).limit(500).get();
    return rows.docs.map(row => { const { lease_until, run_id, ...data } = row.data(); return { ...data, id: row.id }; })
      .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)));
  }
  async create(user: AuthenticatedUser, body: ScheduleInput) {
    const timezone = text(body.timezone, 'timezone', 100);
    const next = nextRunAt(body.scheduleRule, timezone);
    const title = text(body.title, 'title', 200);
    const prompt = text(body.originalPrompt, 'prompt', 10000);
    const payload = metadata(body.taskPayload);
    const source = body.sourceThreadId ? identifier(body.sourceThreadId) : null;
    if (source) await this.data.getThread(user, source);
    const now = new Date().toISOString();
    const ref = this.collection().doc();
    const row = {
      id: ref.id, user_id: user.uid, user_email: user.email, title,
      original_prompt: prompt, task_type: 'generic_prompt', task_payload: payload,
      schedule_rule: metadata(body.scheduleRule), timezone, delivery: text(body.delivery || 'chat', 'delivery', 50),
      source_thread_id: source, status: 'active', next_run_at: next,
      last_run_at: null, last_run_status: null, last_run_summary: null, last_run_error: null,
      runsCount: 0, created_at: now, updated_at: now,
    };
    await ref.create(row);
    return row;
  }
  async setStatus(user: AuthenticatedUser, id: string, status: unknown) {
    if (status !== 'active' && status !== 'paused') throw new BadRequestException('Invalid schedule status.');
    const ref = this.collection().doc(identifier(id));
    return this.firebase.db().runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      const row = snapshot.data() as StoredSchedule | undefined;
      if (!row || row.user_id !== user.uid) throw new NotFoundException('Schedule not found.');
      const patch = { status, updated_at: new Date().toISOString(), ...(status === 'active' ? { next_run_at: nextRunAt(row.schedule_rule, row.timezone) } : {}) };
      tx.update(ref, patch);
      return { ...row, ...patch };
    });
  }
  private worker() {
    const address = process.env.QUANTUM_AGENT_WORKER_URL;
    const secret = process.env.QUANTUM_AGENT_WORKER_SECRET;
    if (!address || !secret || secret.length < 32) throw new ServiceUnavailableException('Scheduled agent execution is not configured.');
    const url = new URL(address);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new ServiceUnavailableException('Worker URL must use HTTPS.');
    return { url: url.toString(), secret };
  }
  async run(id: string, user?: AuthenticatedUser) {
    const worker = this.worker();
    const ref = this.collection().doc(identifier(id));
    const runId = randomUUID();
    const task = await this.firebase.db().runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      const row = snapshot.data() as StoredSchedule | undefined;
      if (!row || (user && row.user_id !== user.uid)) throw new NotFoundException('Schedule not found.');
      if ((row.lease_until || 0) > Date.now()) throw new ConflictException('This task is already running.');
      if (!user && (row.status !== 'active' || row.next_run_at > new Date().toISOString())) return null;
      tx.update(ref, { run_id: runId, lease_until: Date.now() + 10 * 60_000 });
      return row;
    });
    if (!task) return { skipped: true };
    let output = '';
    let failure: string | null = null;
    try {
      const response = await fetch(worker.url, {
        method: 'POST', signal: AbortSignal.timeout(5 * 60_000),
        headers: { Authorization: `Bearer ${worker.secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, userId: task.user_id, prompt: task.original_prompt, taskPayload: task.task_payload, delivery: task.delivery }),
      });
      if (!response.ok) throw new Error(`Agent worker returned ${response.status}.`);
      const result = await response.json() as { output?: string };
      output = text(result.output, 'agent output');
      const owner = { uid: task.user_id, email: task.user_email, roles: [] };
      let threadId = task.source_thread_id;
      if (!threadId) { await this.data.createThread(owner, { type: 'main', title: 'Main Chat' }); threadId = 'main'; }
      await this.data.saveMessage(owner, threadId, { role: 'assistant', content: output, metadata: { scheduled_task_id: id, run_id: runId } });
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Scheduled task failed.';
    }
    const now = new Date().toISOString();
    await this.firebase.db().runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      if (!current || current.run_id !== runId) return;
      tx.update(ref, {
        lease_until: 0, last_run_at: now, last_run_status: failure ? 'failed' : 'completed',
        last_run_summary: output.slice(0, 4000) || null, last_run_error: failure,
        runsCount: Number(current.runsCount || 0) + 1,
        next_run_at: nextRunAt(task.schedule_rule, task.timezone), updated_at: now,
      });
      tx.set(ref.collection('runs').doc(runId), { id: runId, status: failure ? 'failed' : 'completed', output, error: failure, created_at: now });
    });
    if (failure) throw new ServiceUnavailableException(failure);
    return { id, status: 'completed', output };
  }
  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = await this.collection().where('status', '==', 'active').where('next_run_at', '<=', new Date().toISOString()).orderBy('next_run_at').limit(10).get();
      await Promise.allSettled(due.docs.map(doc => this.run(doc.id)));
    } catch (error) { this.logger.error(error instanceof Error ? error.message : 'Schedule dispatcher failed.'); }
    finally { this.ticking = false; }
  }
}
