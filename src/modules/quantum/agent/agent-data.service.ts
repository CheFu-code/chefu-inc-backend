import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { FirebaseAdminService } from '../../firebase-admin/firebase-admin.service';
import { AuthenticatedUser } from '../../auth/authenticated-user';
import { identifier, metadata, text } from './agent-validation';

@Injectable()
export class QuantumAgentDataService {
  constructor(@Inject(FirebaseAdminService) private readonly firebase: FirebaseAdminService) {}

  user(uid: string) { return this.firebase.db().collection('quantum_agent_users').doc(identifier(uid)); }
  threads(uid: string) { return this.user(uid).collection('threads'); }

  async listThreads(user: AuthenticatedUser) {
    const rows = await this.threads(user.uid).orderBy('updated_at', 'desc').limit(200).get();
    return rows.docs.map(doc => ({ ...doc.data(), id: doc.id }));
  }

  async createThread(user: AuthenticatedUser, body: { type?: unknown; title?: unknown }) {
    if (body.type !== 'main' && body.type !== 'side') throw new BadRequestException('Invalid thread type.');
    const ref = this.threads(user.uid).doc(body.type === 'main' ? 'main' : randomUUID());
    return this.firebase.db().runTransaction(async tx => {
      const previous = await tx.get(ref);
      if (previous.exists) return { ...previous.data(), id: ref.id };
      const now = new Date().toISOString();
      const row = { id: ref.id, type: body.type, title: text(body.title || 'New chat', 'title', 200), user_email: user.email, created_at: now, updated_at: now };
      tx.create(ref, row);
      return row;
    });
  }

  async getThread(user: AuthenticatedUser, id: string) {
    const row = await this.threads(user.uid).doc(identifier(id)).get();
    if (!row.exists) throw new NotFoundException('Chat thread not found.');
    return { ...row.data(), id: row.id };
  }

  async listMessages(user: AuthenticatedUser, threadId: string) {
    await this.getThread(user, threadId);
    const rows = await this.threads(user.uid).doc(threadId).collection('messages').orderBy('created_at', 'desc').limit(500).get();
    return rows.docs.map(doc => ({ ...doc.data(), id: doc.id })).reverse();
  }

  async saveMessage(user: AuthenticatedUser, threadId: string, body: { role?: unknown; content?: unknown; metadata?: unknown }) {
    identifier(threadId);
    if (body.role !== 'user' && body.role !== 'assistant') throw new BadRequestException('Invalid message role.');
    const content = text(body.content, 'message');
    const extra = metadata(body.metadata);
    const ref = this.threads(user.uid).doc(threadId);
    const message = ref.collection('messages').doc();
    const now = new Date().toISOString();
    const row = { id: message.id, thread_id: threadId, user_email: user.email, role: body.role, content, metadata: extra, created_at: now };
    await this.firebase.db().runTransaction(async tx => {
      if (!(await tx.get(ref)).exists) throw new NotFoundException('Chat thread not found.');
      tx.create(message, row);
      tx.update(ref, { updated_at: now, ...(body.role === 'assistant' ? { title: content.slice(0, 40) } : {}) });
    });
    return row;
  }

  async updateMessage(user: AuthenticatedUser, threadId: string, messageId: string, body: { content?: unknown; metadata?: unknown }) {
    const ref = this.threads(user.uid).doc(identifier(threadId)).collection('messages').doc(identifier(messageId));
    const patch = { content: text(body.content, 'message'), metadata: metadata(body.metadata), updated_at: new Date().toISOString() };
    return this.firebase.db().runTransaction(async tx => {
      const row = await tx.get(ref);
      if (!row.exists) throw new NotFoundException('Message not found.');
      tx.update(ref, patch);
      return { ...row.data(), ...patch, id: ref.id };
    });
  }

  async deleteThread(user: AuthenticatedUser, id: string) {
    await this.getThread(user, id);
    await this.firebase.db().recursiveDelete(this.threads(user.uid).doc(id));
    return { deleted: true };
  }
}
