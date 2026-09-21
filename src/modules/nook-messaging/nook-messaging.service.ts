import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

const MAX_MESSAGE_LENGTH = 2000;

@Injectable()
export class NookMessagingService {
  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

  async send(
    user: AuthenticatedUser,
    conversationId: string,
    body: { text?: string; requestId?: string },
  ) {
    const text = body.text?.trim() || '';
    const requestId = body.requestId?.trim() || '';
    if (!text || text.length > MAX_MESSAGE_LENGTH || !requestId || requestId.length > 100) {
      throw new BadRequestException('Write a message of 1–2,000 characters.');
    }

    const conversationRef = this.firebaseAdmin.db().collection('nookConversations').doc(conversationId);
    const messageRef = conversationRef.collection('messages').doc(this.messageId(user.uid, requestId));
    const result = await this.firebaseAdmin.db().runTransaction(async transaction => {
      const [conversationSnapshot, existingSnapshot] = await Promise.all([
        transaction.get(conversationRef),
        transaction.get(messageRef),
      ]);
      if (!conversationSnapshot.exists) throw new BadRequestException('Conversation not found.');

      const conversation = conversationSnapshot.data() as {
        participantUids?: string[];
        latestSequence?: number;
      };
      if (!conversation.participantUids?.includes(user.uid)) {
        throw new ForbiddenException('Not authorized to access this conversation.');
      }
      if (existingSnapshot.exists) {
        const existing = existingSnapshot.data() as { text?: string };
        if (existing.text !== text) throw new BadRequestException('Retry does not match the original message.');
        return { id: messageRef.id, sequence: existingSnapshot.get('sequence') as number };
      }

      const sequence = (conversation.latestSequence || 0) + 1;
      transaction.set(messageRef, {
        senderUid: user.uid,
        senderEmail: user.email,
        text,
        requestId,
        sequence,
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.update(conversationRef, {
        latestSequence: sequence,
        preview: text.slice(0, 200),
        lastMessageAt: Timestamp.now(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { id: messageRef.id, sequence };
    });

    return { ...result, saved: true };
  }

  private messageId(uid: string, requestId: string) {
    return createHash('sha256').update(`${uid}:${requestId}`).digest('hex');
  }
}