import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

const MAX_MESSAGE_LENGTH = 2000;

@Injectable()
export class NookMessagingService {
  private readonly logger = new Logger(NookMessagingService.name);

  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

  async registerPushToken(
    user: AuthenticatedUser,
    body: { token?: string; platform?: 'ios' | 'android' },
  ) {
    const token = String(body.token || '').trim();
    if (
      token.length > 256 ||
      !/^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/.test(token) ||
      (body.platform !== 'ios' && body.platform !== 'android')
    ) {
      throw new BadRequestException('A valid device push token and platform are required.');
    }
    const ref = this.firebaseAdmin.db().collection('nookPushTokens')
      .doc(createHash('sha256').update(token).digest('hex'));
    await ref.set({
      uid: user.uid,
      token,
      platform: body.platform,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { registered: true };
  }

  async removePushToken(user: AuthenticatedUser, body: { token?: string }) {
    const token = String(body.token || '').trim();
    if (!/^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/.test(token)) {
      throw new BadRequestException('A valid device push token is required.');
    }
    const ref = this.firebaseAdmin.db().collection('nookPushTokens')
      .doc(createHash('sha256').update(token).digest('hex'));
    const snapshot = await ref.get();
    if (snapshot.exists && snapshot.get('uid') === user.uid) await ref.delete();
    return { removed: true };
  }

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
        unreadCountBy?: Record<string, number>;
      };
      if (!conversation.participantUids?.includes(user.uid)) {
        throw new ForbiddenException('Not authorized to access this conversation.');
      }
      const recipientUid = conversation.participantUids.find(uid => uid !== user.uid);
      if (!recipientUid) throw new BadRequestException('Conversation recipient not found.');
      if (existingSnapshot.exists) {
        const existing = existingSnapshot.data() as { text?: string };
        if (existing.text !== text) throw new BadRequestException('Retry does not match the original message.');
        return { id: messageRef.id, sequence: existingSnapshot.get('sequence') as number, recipientUid, created: false };
      }

      const sequence = (conversation.latestSequence || 0) + 1;
      const unreadCount = Number(conversation.unreadCountBy?.[recipientUid] || 0);
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
        lastSenderUid: user.uid,
        [`unreadCountBy.${recipientUid}`]: unreadCount + 1,
        lastMessageAt: Timestamp.now(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { id: messageRef.id, sequence, recipientUid, created: true };
    });

    if (result.created) {
      void this.notifyRecipient(user, result.recipientUid, conversationId, text)
        .catch(error => this.logger.error('Failed to send Nook message push notification.', error));
    }

    return { id: result.id, sequence: result.sequence, saved: true };
  }

  private async notifyRecipient(
    sender: AuthenticatedUser,
    recipientUid: string,
    conversationId: string,
    text: string,
  ) {
    const db = this.firebaseAdmin.db();
    const [tokens, profile] = await Promise.all([
      db.collection('nookPushTokens').where('uid', '==', recipientUid).get(),
      db.collection('nookSocialProfiles').doc(sender.uid).get(),
    ]);
    if (tokens.empty) return;
    const username = String(profile.get('username') || 'New message');
    const endpoints = tokens.docs.map(document => ({
      ref: document.ref,
      token: String(document.get('token') || ''),
    })).filter(device => device.token);

    for (let index = 0; index < endpoints.length; index += 100) {
      const batch = endpoints.slice(index, index + 100);
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(batch.map(device => ({
          to: device.token,
          title: username,
          body: text.slice(0, 200),
          sound: 'default',
          channelId: 'messages',
          priority: 'high',
          data: { type: 'message', conversationId },
        }))),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Expo Push API returned HTTP ${response.status}.`);

      const payload = await response.json() as {
        data?: Array<{ status?: string; details?: { error?: string }; message?: string }>;
      };
      if (!Array.isArray(payload.data) || payload.data.length !== batch.length) {
        throw new Error('Expo Push API returned an invalid ticket response.');
      }
      const tickets = payload.data;
      await Promise.all(tickets.flatMap((ticket, ticketIndex) =>
        ticket.details?.error === 'DeviceNotRegistered'
          ? [batch[ticketIndex]?.ref.delete()]
          : [],
      ));
      if (tickets.some(ticket => ticket.status === 'error' && ticket.details?.error !== 'DeviceNotRegistered')) {
        this.logger.warn(`Expo Push API reported a delivery error for conversation ${conversationId}.`);
      }
    }
  }

  private messageId(uid: string, requestId: string) {
    return createHash('sha256').update(`${uid}:${requestId}`).digest('hex');
  }
}