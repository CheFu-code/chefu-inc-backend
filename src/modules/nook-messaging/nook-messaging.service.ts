import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

const MAX_MESSAGE_LENGTH = 2000;
const DELETE_FOR_EVERYONE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000;
const MESSAGE_REACTIONS = new Set(['👍', '❤️', '😂', '😮', '😢', '🙏']);

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
    body: { text?: string; requestId?: string; replyToId?: string },
  ) {
    const text = body.text?.trim() || '';
    const requestId = body.requestId?.trim() || '';
    if (!text || text.length > MAX_MESSAGE_LENGTH || !requestId || requestId.length > 100) {
      throw new BadRequestException('Write a message of 1–2,000 characters.');
    }
    const replyToId = body.replyToId?.trim();
    if (replyToId && (replyToId.length > 100 || replyToId.includes('/'))) {
      throw new BadRequestException('Invalid replied-to message.');
    }

    const conversationRef = this.firebaseAdmin.db().collection('nookConversations').doc(conversationId);
    const messageRef = conversationRef.collection('messages').doc(this.messageId(user.uid, requestId));
    const messagesRef = conversationRef.collection('messages');
    const replyToRef = replyToId
      ? messagesRef.doc(
        replyToId.length === 36 ? this.messageId(user.uid, replyToId) : replyToId,
      )
      : null;
    const result = await this.firebaseAdmin.db().runTransaction(async transaction => {
      const [conversationSnapshot, existingSnapshot, replyToSnapshot] = await Promise.all([
        transaction.get(conversationRef),
        transaction.get(messageRef),
        ...(replyToRef ? [transaction.get(replyToRef)] : []),
      ]);
      if (!conversationSnapshot.exists) throw new BadRequestException('Conversation not found.');

      const conversation = conversationSnapshot.data() as {
        participantUids?: string[];
        latestSequence?: number;
        unreadCountBy?: Record<string, number>;
        requestStatus?: string;
        requesterUid?: string;
        requestMessageCount?: number;
      };
      if (!conversation.participantUids?.includes(user.uid)) {
        throw new ForbiddenException('Not authorized to access this conversation.');
      }
      const recipientUid = conversation.participantUids.find(uid => uid !== user.uid);
      if (!recipientUid) throw new BadRequestException('Conversation recipient not found.');
      if (existingSnapshot.exists) {
        const existing = existingSnapshot.data() as { text?: string; replyToId?: string };
        if (existing.text !== text || existing.replyToId !== replyToId) {
          throw new BadRequestException('Retry does not match the original message.');
        }
        return { id: messageRef.id, sequence: existingSnapshot.get('sequence') as number, recipientUid, created: false };
      }
      if (conversation.requestStatus === 'pending') {
        if (user.uid !== conversation.requesterUid) {
          throw new ForbiddenException('This message request must be accepted before you can reply.');
        }
        if (Number(conversation.requestMessageCount || 0) >= 3) {
          throw new ForbiddenException('You have reached the three-message limit for this request.');
        }
      } else if (conversation.requestStatus === 'declined') {
        throw new ForbiddenException('This message request was declined.');
      }

      const replyToData = replyToSnapshot?.exists
        ? replyToSnapshot.data() as { text?: string; senderUid?: string }
        : null;
      if (replyToRef && (!replyToData || !replyToData.senderUid)) {
        throw new BadRequestException('The message you are replying to is unavailable.');
      }
      const sequence = (conversation.latestSequence || 0) + 1;
      const unreadCount = Number(conversation.unreadCountBy?.[recipientUid] || 0);
      transaction.set(messageRef, {
        senderUid: user.uid,
        senderEmail: user.email,
        text,
        requestId,
        ...(replyToRef && replyToData
          ? {
            replyToId: replyToRef.id,
            replyTo: {
              messageId: replyToRef.id,
              senderUid: replyToData.senderUid,
              text: String(replyToData.text || '').slice(0, MAX_MESSAGE_LENGTH),
            },
          }
          : {}),
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
        previewDeletedForUids: FieldValue.arrayRemove(...conversation.participantUids),
        ...(conversation.requestStatus === 'pending'
          ? { requestMessageCount: Number(conversation.requestMessageCount || 0) + 1 }
          : {}),
      });
      return { id: messageRef.id, sequence, recipientUid, created: true };
    });

    if (result.created) {
      void this.notifyRecipient(user, result.recipientUid, conversationId, text)
        .catch(error => this.logger.error('Failed to send Nook message push notification.', error));
    }

    return { id: result.id, sequence: result.sequence, saved: true };
  }

  async setReaction(
    user: AuthenticatedUser,
    conversationId: string,
    messageId: string,
    body: { emoji?: string | null },
  ) {
    const emoji = body.emoji ?? null;
    if (emoji !== null && (typeof emoji !== 'string' || !MESSAGE_REACTIONS.has(emoji))) {
      throw new BadRequestException('Choose a supported message reaction.');
    }
    if (!messageId || messageId.length > 200 || messageId.includes('/')) {
      throw new BadRequestException('Invalid message.');
    }

    const conversationRef = this.firebaseAdmin.db()
      .collection('nookConversations').doc(conversationId);
    const messageRef = conversationRef.collection('messages').doc(messageId);
    return this.firebaseAdmin.db().runTransaction(async transaction => {
      const conversationSnapshot = await transaction.get(conversationRef);
      if (!conversationSnapshot.exists) {
        throw new BadRequestException('Conversation not found.');
      }
      const participants = conversationSnapshot.get('participantUids') as string[] | undefined;
      if (!participants?.includes(user.uid)) {
        throw new ForbiddenException('Not authorized to access this conversation.');
      }
      const messageSnapshot = await transaction.get(messageRef);
      if (!messageSnapshot.exists) {
        throw new BadRequestException('Message not found.');
      }

      const reactionsBy = {
        ...((messageSnapshot.get('reactionsBy') as Record<string, string> | undefined) || {}),
      };
      if (emoji) reactionsBy[user.uid] = emoji;
      else delete reactionsBy[user.uid];
      transaction.update(messageRef, { reactionsBy });
      return this.summarizeReactions(reactionsBy, user.uid);
    });
  }

  async editMessage(
    user: AuthenticatedUser,
    conversationId: string,
    messageId: string,
    body: { text?: string },
  ) {
    const text = body.text?.trim() || '';
    if (!text || text.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestException('Write a message of 1–2,000 characters.');
    }
    this.validateMessageId(messageId);
    const conversationRef = this.firebaseAdmin.db()
      .collection('nookConversations').doc(conversationId);
    const messageRef = conversationRef.collection('messages').doc(messageId);
    await this.firebaseAdmin.db().runTransaction(async transaction => {
      const [conversation, message] = await Promise.all([
        transaction.get(conversationRef),
        transaction.get(messageRef),
      ]);
      if (!conversation.exists) throw new BadRequestException('Conversation not found.');
      if (!(conversation.get('participantUids') as string[] | undefined)?.includes(user.uid)) {
        throw new ForbiddenException('Not authorized to access this conversation.');
      }
      if (!message.exists) throw new BadRequestException('Message not found.');
      if (message.get('senderUid') !== user.uid) {
        throw new ForbiddenException('You can only edit your own messages.');
      }
      if (message.get('deletedForEveryone')) {
        throw new BadRequestException('This message was deleted.');
      }
      const updates: Record<string, unknown> = {
        text,
        editedAt: FieldValue.serverTimestamp(),
      };
      if (Number(conversation.get('latestSequence') || 0) === Number(message.get('sequence') || 0)) {
        updates.preview = text.slice(0, 200);
      }
      transaction.update(messageRef, updates);
      if ('preview' in updates) {
        transaction.update(conversationRef, {
          preview: updates.preview,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    });
    return { edited: true };
  }

  async deleteMessageForMe(
    user: AuthenticatedUser,
    conversationId: string,
    messageId: string,
  ) {
    this.validateMessageId(messageId);
    const conversationRef = this.firebaseAdmin.db()
      .collection('nookConversations').doc(conversationId);
    const messageRef = conversationRef.collection('messages').doc(messageId);
    await this.firebaseAdmin.db().runTransaction(async transaction => {
      const conversation = await transaction.get(conversationRef);
      if (!conversation.exists) throw new BadRequestException('Conversation not found.');
      if (!(conversation.get('participantUids') as string[] | undefined)?.includes(user.uid)) {
        throw new ForbiddenException('Not authorized to access this conversation.');
      }
      const message = await transaction.get(messageRef);
      if (!message.exists) throw new BadRequestException('Message not found.');
      transaction.update(messageRef, {
        deletedForUids: FieldValue.arrayUnion(user.uid),
      });
      if (
        Number(conversation.get('latestSequence') || 0) ===
        Number(message.get('sequence') || 0)
      ) {
        transaction.update(conversationRef, {
          previewDeletedForUids: FieldValue.arrayUnion(user.uid),
        });
      }
    });
    return { deleted: true };
  }

  async deleteMessageForEveryone(
    user: AuthenticatedUser,
    conversationId: string,
    messageId: string,
  ) {
    this.validateMessageId(messageId);
    const conversationRef = this.firebaseAdmin.db()
      .collection('nookConversations').doc(conversationId);
    const messageRef = conversationRef.collection('messages').doc(messageId);
    await this.firebaseAdmin.db().runTransaction(async transaction => {
      const [conversation, message] = await Promise.all([
        transaction.get(conversationRef),
        transaction.get(messageRef),
      ]);
      if (!conversation.exists) throw new BadRequestException('Conversation not found.');
      if (!(conversation.get('participantUids') as string[] | undefined)?.includes(user.uid)) {
        throw new ForbiddenException('Not authorized to access this conversation.');
      }
      if (!message.exists) throw new BadRequestException('Message not found.');
      if (message.get('senderUid') !== user.uid) {
        throw new ForbiddenException('You can only delete your own messages for everyone.');
      }
      if (message.get('deletedForEveryone')) {
        throw new BadRequestException('This message was already deleted.');
      }
      const createdAt = message.get('createdAt');
      const createdAtMs = createdAt instanceof Timestamp ? createdAt.toMillis() : 0;
      if (
        !createdAtMs ||
        createdAtMs > Date.now() ||
        Date.now() - createdAtMs > DELETE_FOR_EVERYONE_WINDOW_MS
      ) {
        throw new ForbiddenException('The time limit to delete this message for everyone has passed.');
      }
      transaction.update(messageRef, {
        text: '',
        replyTo: FieldValue.delete(),
        replyToId: FieldValue.delete(),
        reactionsBy: {},
        deletedForEveryone: true,
        deletedAt: FieldValue.serverTimestamp(),
      });
      if (Number(conversation.get('latestSequence') || 0) === Number(message.get('sequence') || 0)) {
        transaction.update(conversationRef, {
          preview: 'This message was deleted.',
          previewDeletedForUids: FieldValue.arrayRemove(
            ...(conversation.get('participantUids') as string[]),
          ),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    });
    return { deleted: true };
  }

  async getReactions(
    user: AuthenticatedUser,
    conversationId: string,
    messageId: string,
  ) {
    if (!messageId || messageId.length > 200 || messageId.includes('/')) {
      throw new BadRequestException('Invalid message.');
    }
    const conversationRef = this.firebaseAdmin.db()
      .collection('nookConversations').doc(conversationId);
    const [conversation, message] = await Promise.all([
      conversationRef.get(),
      conversationRef.collection('messages').doc(messageId).get(),
    ]);
    if (!conversation.exists) throw new BadRequestException('Conversation not found.');
    const participants = conversation.get('participantUids') as string[] | undefined;
    if (!participants?.includes(user.uid)) {
      throw new ForbiddenException('Not authorized to access this conversation.');
    }
    if (!message.exists) throw new BadRequestException('Message not found.');
    const reactionsBy =
      (message.get('reactionsBy') as Record<string, string> | undefined) || {};
    const rows = Object.entries(reactionsBy).filter(([, emoji]) =>
      MESSAGE_REACTIONS.has(emoji),
    );
    const profiles = await Promise.all(
      rows.map(async ([uid, emoji]) => {
        const profile = await this.firebaseAdmin.db()
          .collection('nookSocialProfiles').doc(uid).get();
        return {
          user: {
            _id: uid,
            username: String(profile.get('username') || 'nook member'),
            name: String(profile.get('name') || profile.get('username') || 'Nook member'),
            hasAvatar: Boolean(profile.get('avatarPath')),
            avatarVersion: Number(profile.get('avatarVersion') || 0),
          },
          emoji,
          isOwn: uid === user.uid,
        };
      }),
    );
    return profiles;
  }

  private validateMessageId(messageId: string) {
    if (!messageId || messageId.length > 200 || messageId.includes('/')) {
      throw new BadRequestException('Invalid message.');
    }
  }

  summarizeReactions(
    reactionsBy: Record<string, string>,
    userId: string,
  ) {
    const counts = new Map<string, number>();
    for (const value of Object.values(reactionsBy)) {
      if (MESSAGE_REACTIONS.has(value)) counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()].map(([emoji, count]) => ({
      emoji,
      count,
      reacted: reactionsBy[userId] === emoji,
    }));
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