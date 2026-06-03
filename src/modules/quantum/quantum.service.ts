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
  QuantumGeneratedImage,
  QuantumMessage,
  QuantumMessageRole,
} from './quantum.types';

const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES_PER_CONVERSATION = 100;
const MAX_MESSAGE_LENGTH = 30000;
const MAX_GENERATED_IMAGES_PER_MESSAGE = 4;
const MAX_GENERATED_IMAGE_DATA_LENGTH = 700000;
const MAX_GENERATED_IMAGE_DATA_PER_CONVERSATION = 900000;

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

  async upsertConversation(
    user: AuthenticatedUser,
    conversation: QuantumConversation | undefined,
    conversationId?: string,
  ) {
    if (!conversation) {
      throw new BadRequestException('conversation is required.');
    }

    const normalized = this.normalizeConversation({
      ...conversation,
      id: conversationId || conversation.id,
    });

    await this.conversationsCollection(user).doc(normalized.id).set(
      {
        ...normalized,
        ownerUid: user.uid,
        ownerEmail: user.email,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      conversation: normalized,
      saved: true,
    };
  }

  async deleteConversation(user: AuthenticatedUser, conversationId: string) {
    const id = this.cleanId(conversationId);
    if (!id) throw new BadRequestException('Conversation id is required.');

    await this.conversationsCollection(user).doc(id).delete();

    return {
      deleted: true,
      id,
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

    const normalized = messages
      .slice(-MAX_MESSAGES_PER_CONVERSATION)
      .map(message => this.normalizeMessage(message));

    let remainingImageBudget = MAX_GENERATED_IMAGE_DATA_PER_CONVERSATION;

    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      const message = normalized[index];
      const keptImages = [];

      for (const image of message.generatedImages || []) {
        if (image.data.length > remainingImageBudget) continue;
        keptImages.push(image);
        remainingImageBudget -= image.data.length;
      }

      message.generatedImages = keptImages;
    }

    return normalized;
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
      generatedImages: this.normalizeGeneratedImages(value.generatedImages),
      timestamp: this.cleanDate(value.timestamp),
    };
  }

  private normalizeGeneratedImages(images: QuantumGeneratedImage[] = []) {
    if (!Array.isArray(images)) return [];

    return images
      .slice(0, MAX_GENERATED_IMAGES_PER_MESSAGE)
      .map(image => this.normalizeGeneratedImage(image))
      .filter((image): image is QuantumGeneratedImage => Boolean(image));
  }

  private normalizeGeneratedImage(
    value: QuantumGeneratedImage,
  ): QuantumGeneratedImage | null {
    if (!value || typeof value !== 'object') return null;

    const mimeType = this.cleanMimeType(value.mimeType);
    const data = this.cleanBase64ImageData(value.data);

    if (!mimeType || !data) return null;

    return {
      id: this.cleanId(value.id) || randomUUID(),
      mimeType,
      data,
      alt: this.cleanText(value.alt, 180) || 'Generated image',
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

  private cleanMimeType(value: unknown) {
    const mimeType = String(value || '').trim().toLowerCase();
    return /^image\/(png|jpeg|jpg|webp)$/.test(mimeType) ? mimeType : '';
  }

  private cleanBase64ImageData(value: unknown) {
    const data = String(value || '').replace(/\s/g, '');
    if (!data || data.length > MAX_GENERATED_IMAGE_DATA_LENGTH) return '';
    return /^[a-zA-Z0-9+/]+={0,2}$/.test(data) ? data : '';
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
      generatedImages: Array.isArray(data.generatedImages)
        ? data.generatedImages
            .map(image => this.toGeneratedImage(image))
            .filter((image): image is QuantumGeneratedImage => Boolean(image))
        : [],
      timestamp: this.serializeDate(data.timestamp),
    };
  }

  private toGeneratedImage(data: DocumentData): QuantumGeneratedImage | null {
    const mimeType = this.cleanMimeType(data.mimeType);
    const imageData = this.cleanBase64ImageData(data.data);

    if (!mimeType || !imageData) return null;

    return {
      id: String(data.id || randomUUID()),
      mimeType,
      data: imageData,
      alt: String(data.alt || 'Generated image'),
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
