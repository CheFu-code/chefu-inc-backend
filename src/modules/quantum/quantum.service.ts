import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DocumentData, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import {
  QuantumConversation,
  QuantumMessage,
  QuantumMessageRole,
} from './quantum.types';

const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES_PER_CONVERSATION = 100;
const MAX_MESSAGE_LENGTH = 30000;

@Injectable()
export class QuantumService {
  private readonly logger = new Logger(QuantumService.name);

  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebaseAdmin: FirebaseAdminService,
  ) {}

  async listConversations(user: AuthenticatedUser) {
    const snapshot = await this.conversationsCollection(user)
      .orderBy('timestamp', 'desc')
      .limit(MAX_CONVERSATIONS)
      .get();

    return {
      conversations: snapshot.docs.map(doc =>
        this.toConversation(doc.id, doc.data()),
      ),
    };
  }

  async replaceConversations(
    user: AuthenticatedUser,
    conversations: QuantumConversation[] = [],
  ) {
    if (!Array.isArray(conversations)) {
      throw new BadRequestException('conversations must be an array.');
    }

    const normalized = conversations
      .slice(0, MAX_CONVERSATIONS)
      .map(conversation => this.normalizeConversation(conversation));
    const collection = this.conversationsCollection(user);
    const existingSnapshot = await collection.get();
    const incomingIds = new Set(normalized.map(conversation => conversation.id));
    const batch = this.firebaseAdmin.db().batch();

    for (const doc of existingSnapshot.docs) {
      if (!incomingIds.has(doc.id)) {
        batch.delete(doc.ref);
      }
    }

    for (const conversation of normalized) {
      batch.set(
        collection.doc(conversation.id),
        {
          ...conversation,
          ownerUid: user.uid,
          ownerEmail: user.email,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    await batch.commit();

    this.logger.log(
      JSON.stringify({
        event: 'quantum_conversations_saved',
        uid: user.uid,
        email: user.email,
        count: normalized.length,
      }),
    );

    return {
      saved: true,
      count: normalized.length,
    };
  }

  private conversationsCollection(user: AuthenticatedUser) {
    return this.firebaseAdmin
      .db()
      .collection('users')
      .doc(user.email || user.uid)
      .collection('quantumConversations');
  }

  private normalizeConversation(value: QuantumConversation) {
    if (!value || typeof value !== 'object') {
      throw new BadRequestException('Invalid conversation.');
    }

    const id = this.cleanId(value.id);
    if (!id) throw new BadRequestException('Conversation id is required.');

    return {
      id,
      title: this.cleanText(value.title, 120) || 'New conversation',
      preview: this.cleanText(value.preview, 220),
      timestamp: this.cleanDate(value.timestamp),
      starred: Boolean(value.starred),
      messages: this.normalizeMessages(value.messages),
    };
  }

  private normalizeMessages(messages: QuantumMessage[] = []) {
    if (!Array.isArray(messages)) return [];

    return messages
      .slice(-MAX_MESSAGES_PER_CONVERSATION)
      .map(message => this.normalizeMessage(message));
  }

  private normalizeMessage(value: QuantumMessage) {
    if (!value || typeof value !== 'object') {
      throw new BadRequestException('Invalid message.');
    }

    const role = this.normalizeRole(value.role);
    if (!role) throw new BadRequestException('Invalid message role.');

    return {
      id: this.cleanId(value.id) || randomUUID(),
      role,
      content: this.cleanText(value.content, MAX_MESSAGE_LENGTH),
      timestamp: this.cleanDate(value.timestamp),
    };
  }

  private normalizeRole(value: unknown): QuantumMessageRole | null {
    return value === 'user' || value === 'assistant' ? value : null;
  }

  private cleanId(value: unknown) {
    return String(value || '')
      .trim()
      .replace(/[^a-zA-Z0-9._:-]/g, '')
      .slice(0, 140);
  }

  private cleanText(value: unknown, maxLength: number) {
    return String(value || '')
      .replace(/\0/g, '')
      .trim()
      .slice(0, maxLength);
  }

  private cleanDate(value: unknown) {
    const date = new Date(String(value || ''));
    return Number.isNaN(date.getTime())
      ? new Date().toISOString()
      : date.toISOString();
  }

  private toConversation(id: string, data: DocumentData) {
    return {
      id,
      title: String(data.title || 'New conversation'),
      preview: String(data.preview || ''),
      timestamp: this.serializeDate(data.timestamp),
      starred: Boolean(data.starred),
      messages: Array.isArray(data.messages)
        ? data.messages.map(message => this.toMessage(message))
        : [],
    };
  }

  private toMessage(data: DocumentData) {
    return {
      id: String(data.id || randomUUID()),
      role: this.normalizeRole(data.role) || 'assistant',
      content: String(data.content || ''),
      timestamp: this.serializeDate(data.timestamp),
    };
  }

  private serializeDate(value: unknown) {
    if (value instanceof Timestamp) {
      return value.toDate().toISOString();
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (typeof value === 'string') {
      return this.cleanDate(value);
    }

    return new Date().toISOString();
  }
}
