import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Transaction } from 'firebase-admin/firestore';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { backoff, digest } from './payment.model';

export type StoreJob = {
  kind: 'verify' | 'webhook' | 'fulfill'; reference: string;
  state: 'queued' | 'running' | 'completed' | 'dead'; attempts: number;
  availableAt: number; createdAt: number; updatedAt: number;
  leaseToken?: string; eventId?: string; lastError?: string;
};

@Injectable()
export class StoreJobsService {
  private readonly logger = new Logger(StoreJobsService.name);
  constructor(@Inject(FirebaseAdminService) private readonly firebase: FirebaseAdminService) {}

  enqueue(tx: Transaction, id: string, kind: StoreJob['kind'], reference: string, delay = 0, eventId?: string) {
    const now = Date.now();
    tx.create(this.firebase.db().collection('storeJobs').doc(id), {
      kind, reference, state: 'queued', attempts: 0, availableAt: now + delay,
      createdAt: now, updatedAt: now, ...(eventId ? { eventId } : {}),
    } satisfies StoreJob);
  }

  async run(handler: (job: StoreJob) => Promise<'done' | 'pending'>) {
    const db = this.firebase.db();
    const due = await db.collection('storeJobs').where('state', 'in', ['queued', 'running'])
      .where('availableAt', '<=', Date.now()).orderBy('availableAt').limit(20).get();
    this.logger.log(JSON.stringify({ event: 'store_job_batch', due: due.size }));
    for (const snapshot of due.docs) {
      const token = randomUUID();
      const job = await db.runTransaction(async tx => {
        const current = (await tx.get(snapshot.ref)).data() as StoreJob | undefined;
        if (!current || !['queued', 'running'].includes(current.state) || current.availableAt > Date.now()) return null;
        const claimed: StoreJob = { ...current, state: 'running', leaseToken: token, attempts: current.attempts + 1, availableAt: Date.now() + 90_000, updatedAt: Date.now() };
        tx.update(snapshot.ref, claimed);
        return claimed;
      });
      if (!job) continue;
      let outcome: 'done' | 'pending' = 'pending';
      let errorCode = 'awaiting_provider';
      try { outcome = await handler(job); } catch { errorCode = 'processing_unavailable'; }
      await db.runTransaction(async tx => {
        const current = (await tx.get(snapshot.ref)).data() as StoreJob;
        if (current.leaseToken !== token || current.state !== 'running') return;
        const dead = outcome !== 'done' && (current.attempts >= 40 || Date.now() - current.createdAt > 7 * 24 * 60 * 60_000);
        tx.update(snapshot.ref, {
          state: outcome === 'done' ? 'completed' : dead ? 'dead' : 'queued',
          availableAt: Date.now() + backoff(current.attempts), updatedAt: Date.now(),
          lastError: outcome === 'done' ? '' : errorCode, leaseToken: '',
        });
        if (dead) {
          tx.set(db.collection('storeAlerts').doc(digest(`dead:${snapshot.id}`)), { type: 'job_dead_letter', reference: current.reference, jobId: snapshot.id, createdAt: Date.now(), resolved: false });
          this.logger.error(JSON.stringify({ event: 'store_job_dead_letter', reference: current.reference, jobId: snapshot.id }));
        }
      });
    }
  }

  async retry(id: string, actorUid: string) {
    const db = this.firebase.db();
    const ref = db.collection('storeJobs').doc(id);
    return db.runTransaction(async tx => {
      const job = (await tx.get(ref)).data() as StoreJob | undefined;
      if (!job || !['dead', 'queued'].includes(job.state)) return { retried: false };
      tx.update(ref, { state: 'queued', attempts: 0, availableAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now() });
      tx.create(db.collection('storePaymentAudit').doc(randomUUID()), { action: 'JOB_RETRY', jobId: id, reference: job.reference, actorHash: digest(actorUid), createdAt: Date.now() });
      return { retried: true };
    });
  }
}
