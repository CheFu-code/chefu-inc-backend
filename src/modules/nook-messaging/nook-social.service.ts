import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

type ProfileDocument = {
  uid: string;
  email: string;
  username: string;
  normalizedUsername: string;
  name: string;
  bio?: string;
  website?: string;
  location?: string;
  avatarPath?: string;
  avatarVersion?: number;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
};

type PostDocument = {
  uid: string;
  uploadPath: string;
  kind: 'image' | 'video';
  caption: string;
  width: number;
  height: number;
  duration?: number;
  createdAt: Timestamp;
};

type StoryDocument = {
  uid: string;
  uploadPath: string;
  caption: string;
  expiresAt: Timestamp;
  createdAt: Timestamp;
};

const SOCIAL = 'nookSocialProfiles';
const POSTS = 'nookSocialPosts';
const STORIES = 'nookSocialStories';
const FOLLOWS = 'nookSocialFollows';
const BOOKMARKS = 'nookSocialBookmarks';
const MAX_PAGE_SIZE = 50;
const USERNAME_PATTERN = /^[a-z0-9._]{3,30}$/;

@Injectable()
export class NookSocialService {
  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

  async profile(user: AuthenticatedUser) {
    const snapshot = await this.profileRef(user.uid).get();
    return snapshot.exists ? this.presentProfile(snapshot.id, snapshot.data() as ProfileDocument, user.uid) : null;
  }

  async createProfile(user: AuthenticatedUser, body: { username?: string; name?: string }) {
    await this.assertAccountActive(user.uid);
    const username = this.normalizeUsername(body.username);
    const name = this.requireText(body.name, 'Display name', 60);
    const profileRef = this.profileRef(user.uid);
    const usernameRef = this.usernameRef(username);

    await this.firebaseAdmin.db().runTransaction(async transaction => {
      const [existingProfile, existingUsername, deletion] = await Promise.all([
        transaction.get(profileRef),
        transaction.get(usernameRef),
        transaction.get(this.firebaseAdmin.db().collection('nookSocialDeletionRequests').doc(user.uid)),
      ]);
      if (deletion.exists && ['pending', 'complete'].includes(String(deletion.get('state')))) {
        throw new ForbiddenException('This Nook account is being deleted.');
      }
      if (existingProfile.exists) throw new ConflictException('Your profile already exists.');
      if (existingUsername.exists) throw new ConflictException('That username is already taken.');
      const now = FieldValue.serverTimestamp();
      transaction.set(profileRef, {
        uid: user.uid,
        email: user.email,
        username,
        normalizedUsername: username,
        name,
        createdAt: now,
        updatedAt: now,
      });
      transaction.set(usernameRef, { uid: user.uid, createdAt: now });
    });

    return this.profile(user);
  }

  async updateProfile(user: AuthenticatedUser, body: {
    username?: string;
    name?: string;
    bio?: string;
    website?: string;
    location?: string;
  }) {
    await this.assertAccountActive(user.uid);
    const ref = this.profileRef(user.uid);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new NotFoundException('Create your Nook profile first.');
    const current = snapshot.data() as ProfileDocument;
    const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };

    if (body.username !== undefined) {
      const username = this.normalizeUsername(body.username);
      if (username !== current.normalizedUsername) {
        const nextUsernameRef = this.usernameRef(username);
        await this.firebaseAdmin.db().runTransaction(async transaction => {
          const next = await transaction.get(nextUsernameRef);
          if (next.exists && next.get('uid') !== user.uid) {
            throw new ConflictException('That username is already taken.');
          }
          transaction.delete(this.usernameRef(current.normalizedUsername));
          transaction.set(nextUsernameRef, { uid: user.uid, createdAt: FieldValue.serverTimestamp() });
          transaction.update(ref, { username, normalizedUsername: username });
        });
      }
    }
    if (body.name !== undefined) update.name = this.requireText(body.name, 'Display name', 60);
    if (body.bio !== undefined) update.bio = this.optionalText(body.bio, 150);
    if (body.website !== undefined) update.website = this.optionalText(body.website, 200);
    if (body.location !== undefined) update.location = this.optionalText(body.location, 200);
    if (Object.keys(update).length > 1 || body.username === undefined) await ref.set(update, { merge: true });
    return this.getProfileForUser(user.uid, user.uid);
  }

  async getProfile(user: AuthenticatedUser, id: string) {
    const profile = await this.getProfileForUser(id, user.uid);
    return profile;
  }

  async searchProfiles(user: AuthenticatedUser, query: string, page: number, pageSize: number) {
    const normalized = query.trim().toLowerCase().replace(/^@/, '');
    const snapshot = await this.firebaseAdmin.db().collection(SOCIAL).orderBy('normalizedUsername').limit(500).get();
    const profiles = await Promise.all(snapshot.docs
      .filter(doc => !normalized || String(doc.get('normalizedUsername') || '').includes(normalized) ||
        String(doc.get('name') || '').toLowerCase().includes(normalized))
      .map(doc => this.presentProfile(doc.id, doc.data() as ProfileDocument, user.uid)));
    return this.page(profiles, page, pageSize);
  }

  async setFollow(user: AuthenticatedUser, profileId: string, following: boolean) {
    await this.assertAccountActive(user.uid);
    if (profileId === user.uid) throw new BadRequestException('You cannot follow your own profile.');
    const target = await this.profileRef(profileId).get();
    if (!target.exists) throw new NotFoundException('Profile not found.');
    const ref = this.followRef(user.uid, profileId);
    if (following) {
      await ref.set({ followerUid: user.uid, followedUid: profileId, createdAt: FieldValue.serverTimestamp() }, { merge: true });
    } else {
      await ref.delete();
    }
    return { following };
  }

  async connections(user: AuthenticatedUser, profileId: string, kind: 'followers' | 'following', page: number, pageSize: number) {
    const field = kind === 'followers' ? 'followedUid' : 'followerUid';
    const uidField = kind === 'followers' ? 'followerUid' : 'followedUid';
    const rows = await this.firebaseAdmin.db().collection(FOLLOWS).where(field, '==', profileId).limit(500).get();
    rows.docs.sort((left, right) => this.timestampMs(right.get('createdAt')) - this.timestampMs(left.get('createdAt')));
    const profiles = await Promise.all(rows.docs.map(row => this.getProfileForUser(String(row.get(uidField)), user.uid)));
    return this.page(profiles.filter(Boolean), page, pageSize);
  }

  async listPosts(user: AuthenticatedUser, feed: 'home' | 'explore' | 'profile', profileId: string | undefined, page: number, pageSize: number) {
    const follows = feed === 'home'
      ? await this.firebaseAdmin.db().collection(FOLLOWS).where('followerUid', '==', user.uid).limit(500).get()
      : null;
    const allowed = follows ? new Set([user.uid, ...follows.docs.map(doc => String(doc.get('followedUid')))]) : null;
    const query = this.firebaseAdmin.db().collection(POSTS).orderBy('createdAt', 'desc').limit(1000);
    const snapshot = await query.get();
    const filtered = snapshot.docs.filter(doc => {
      const data = doc.data() as PostDocument;
      if (feed === 'profile') return data.uid === profileId;
      if (allowed) return allowed.has(data.uid);
      return true;
    });
    const postRows = await Promise.all(filtered.map(doc => this.presentPost(doc.id, doc.data() as PostDocument, user.uid)));
    return this.page(postRows, page, pageSize);
  }

  async getPost(user: AuthenticatedUser, id: string) {
    const snapshot = await this.firebaseAdmin.db().collection(POSTS).doc(id).get();
    return snapshot.exists ? this.presentPost(snapshot.id, snapshot.data() as PostDocument, user.uid) : null;
  }

  async setPostLike(user: AuthenticatedUser, postId: string, liked: boolean) {
    await this.assertAccountActive(user.uid);
    const post = await this.requirePost(postId);
    const ref = this.firebaseAdmin.db().collection(POSTS).doc(postId).collection('likes').doc(user.uid);
    if (liked) await ref.set({ uid: user.uid, createdAt: FieldValue.serverTimestamp() }, { merge: true });
    else await ref.delete();
    return { liked, uid: post.get('uid') };
  }

  async setBookmark(user: AuthenticatedUser, postId: string, saved: boolean) {
    await this.assertAccountActive(user.uid);
    await this.requirePost(postId);
    const ref = this.firebaseAdmin.db().collection(BOOKMARKS).doc(`${user.uid}_${postId}`);
    if (saved) await ref.set({ uid: user.uid, postId, createdAt: FieldValue.serverTimestamp() }, { merge: true });
    else await ref.delete();
    return { saved };
  }

  async isBookmarked(user: AuthenticatedUser, postId: string) {
    return (await this.firebaseAdmin.db().collection(BOOKMARKS).doc(`${user.uid}_${postId}`).get()).exists;
  }

  async comments(user: AuthenticatedUser, postId: string, order: 'asc' | 'desc', page: number, pageSize: number) {
    await this.requirePost(postId);
    const rows = await this.firebaseAdmin.db().collection(POSTS).doc(postId).collection('comments')
      .orderBy('createdAt', order).limit(1000).get();
    const items = await Promise.all(rows.docs.map(async doc => {
      const comment = doc.data();
      const author = await this.getProfileForUser(String(comment.uid), user.uid);
      const liked = await doc.ref.collection('likes').doc(user.uid).get();
      return {
        _id: doc.id,
        _creationTime: this.timestampMs(comment.createdAt),
        text: String(comment.text || ''),
        author,
        isOwn: comment.uid === user.uid,
        isLiked: liked.exists,
      };
    }));
    return this.page(items, page, pageSize);
  }

  async addComment(user: AuthenticatedUser, postId: string, body: { text?: string; requestId?: string }) {
    await this.assertAccountActive(user.uid);
    const text = this.requireText(body.text, 'Comment', 2000);
    const requestId = body.requestId?.trim();
    if (!requestId || requestId.length > 100) throw new BadRequestException('A valid request ID is required.');
    await this.requirePost(postId);
    const id = createHash('sha256').update(`${user.uid}:${requestId}`).digest('hex');
    const ref = this.firebaseAdmin.db().collection(POSTS).doc(postId).collection('comments').doc(id);
    await this.firebaseAdmin.db().runTransaction(async transaction => {
      const existing = await transaction.get(ref);
      if (existing.exists) {
        if (existing.get('uid') !== user.uid || existing.get('text') !== text) {
          throw new ConflictException('Retry does not match the original comment.');
        }
        return;
      }
      transaction.create(ref, { uid: user.uid, text, requestId, createdAt: FieldValue.serverTimestamp() });
    });
    return { id };
  }

  async deleteComment(user: AuthenticatedUser, postId: string, commentId: string) {
    const ref = this.firebaseAdmin.db().collection(POSTS).doc(postId).collection('comments').doc(commentId);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new NotFoundException('Comment not found.');
    if (snapshot.get('uid') !== user.uid) throw new ForbiddenException('You can only delete your own comment.');
    await this.deleteSubcollection(ref, 'likes');
    await ref.delete();
    return { ok: true };
  }

  async setCommentLike(user: AuthenticatedUser, postId: string, commentId: string, liked: boolean) {
    await this.assertAccountActive(user.uid);
    const comment = this.firebaseAdmin.db().collection(POSTS).doc(postId).collection('comments').doc(commentId);
    if (!(await comment.get()).exists) throw new NotFoundException('Comment not found.');
    const ref = comment.collection('likes').doc(user.uid);
    if (liked) await ref.set({ uid: user.uid, createdAt: FieldValue.serverTimestamp() }, { merge: true });
    else await ref.delete();
    return { liked };
  }

  async createUpload(user: AuthenticatedUser, body: {
    purpose?: 'post' | 'story' | 'avatar';
    kind?: 'image' | 'video';
    width?: number;
    height?: number;
    duration?: number;
  }) {
    await this.assertAccountActive(user.uid);
    if (!['post', 'story', 'avatar'].includes(String(body.purpose)) || !['image', 'video'].includes(String(body.kind))) {
      throw new BadRequestException('Invalid upload purpose or media type.');
    }
    if (body.purpose !== 'post' && body.kind !== 'image') throw new BadRequestException('Stories and avatars must be images.');
    const width = Number(body.width);
    const height = Number(body.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 30_000 || height > 30_000) {
      throw new BadRequestException('Valid media dimensions are required.');
    }
    if (body.kind === 'video' && (!Number.isFinite(body.duration) || Number(body.duration) <= 0 || Number(body.duration) > 30)) {
      throw new BadRequestException('Videos must be no longer than 30 seconds.');
    }
    const id = randomUUID();
    await this.firebaseAdmin.db().collection('nookSocialUploads').doc(id).create({
      uid: user.uid,
      purpose: body.purpose,
      kind: body.kind,
      width,
      height,
      duration: body.duration,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60_000),
    });
    return { id };
  }

  async saveUpload(user: AuthenticatedUser, id: string, buffer: Buffer, mimeType: string) {
    const ref = this.firebaseAdmin.db().collection('nookSocialUploads').doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.get('uid') !== user.uid) {
      throw new NotFoundException('Upload session is unavailable.');
    }
    if (snapshot.get('status') === 'uploaded' && typeof snapshot.get('path') === 'string') return { ok: true };
    if (snapshot.get('status') !== 'pending') throw new NotFoundException('Upload session is unavailable.');
    if (snapshot.get('expiresAt').toMillis() <= Date.now()) throw new BadRequestException('Upload session expired.');
    const purpose = snapshot.get('purpose') as string;
    const kind = snapshot.get('kind') as string;
    const maxBytes = purpose === 'avatar' ? 5 : kind === 'video' ? 50 : 10;
    const allowed = kind === 'video'
      ? ['video/mp4', 'video/quicktime']
      : ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    if (!buffer.length || buffer.length > maxBytes * 1024 * 1024 || !allowed.includes(mimeType.toLowerCase())) {
      throw new BadRequestException(`Choose a supported file under ${maxBytes} MB.`);
    }
    const extension = this.extensionForMime(mimeType);
    const path = `nook/${user.uid}/${id}.${extension}`;
    await this.firebaseAdmin.storageBucket().file(path).save(buffer, {
      resumable: false,
      metadata: { contentType: mimeType, cacheControl: 'private, max-age=300' },
    });
    await ref.update({ path, bytes: buffer.length, status: 'uploaded', updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  }

  async cancelUpload(user: AuthenticatedUser, id: string) {
    const ref = this.firebaseAdmin.db().collection('nookSocialUploads').doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) return { ok: true };
    if (snapshot.get('uid') !== user.uid) throw new ForbiddenException('Upload does not belong to you.');
    if (!['pending', 'uploaded'].includes(String(snapshot.get('status')))) return { ok: true };
    const path = snapshot.get('path');
    if (typeof path === 'string') await this.firebaseAdmin.storageBucket().file(path).delete({ ignoreNotFound: true });
    await ref.delete();
    return { ok: true };
  }

  async publishPost(user: AuthenticatedUser, body: { uploadId?: string; caption?: string }) {
    const profile = await this.profileRef(user.uid).get();
    if (!profile.exists) throw new BadRequestException('Create your profile first.');
    const caption = String(body.caption || '').trim();
    if (caption.length > 2200) throw new BadRequestException('Caption must be 2,200 characters or fewer.');
    if (!body.uploadId) throw new BadRequestException('Upload session is required.');
    const uploadRef = this.firebaseAdmin.db().collection('nookSocialUploads').doc(body.uploadId);
    const postRef = this.firebaseAdmin.db().collection(POSTS).doc(body.uploadId);
    await this.firebaseAdmin.db().runTransaction(async transaction => {
      const [uploadSnapshot, existingPost] = await Promise.all([
        transaction.get(uploadRef),
        transaction.get(postRef),
      ]);
      if (existingPost.exists) {
        if (existingPost.get('uid') !== user.uid || existingPost.get('caption') !== caption) {
          throw new ConflictException('This upload has already been published.');
        }
        return;
      }
      if (!uploadSnapshot.exists || uploadSnapshot.get('uid') !== user.uid ||
          uploadSnapshot.get('purpose') !== 'post' || uploadSnapshot.get('status') !== 'uploaded') {
        throw new NotFoundException('Upload session is unavailable.');
      }
      const upload = uploadSnapshot.data()!;
      transaction.create(postRef, {
        uid: user.uid,
        uploadPath: upload.path,
        kind: upload.kind,
        caption,
        width: upload.width,
        height: upload.height,
        duration: upload.duration,
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.update(uploadRef, { status: 'published', publishedAt: FieldValue.serverTimestamp() });
    });
    return { id: postRef.id };
  }

  async publishStory(user: AuthenticatedUser, body: { uploadId?: string; caption?: string }) {
    const profile = await this.profileRef(user.uid).get();
    if (!profile.exists) throw new BadRequestException('Create your profile first.');
    const caption = String(body.caption || '').trim();
    if (caption.length > 280) throw new BadRequestException('Story caption must be 280 characters or fewer.');
    if (!body.uploadId) throw new BadRequestException('Upload session is required.');
    const uploadRef = this.firebaseAdmin.db().collection('nookSocialUploads').doc(body.uploadId);
    const storyRef = this.firebaseAdmin.db().collection(STORIES).doc(body.uploadId);
    await this.firebaseAdmin.db().runTransaction(async transaction => {
      const [uploadSnapshot, existingStory] = await Promise.all([
        transaction.get(uploadRef),
        transaction.get(storyRef),
      ]);
      if (existingStory.exists) {
        if (existingStory.get('uid') !== user.uid || existingStory.get('caption') !== caption) {
          throw new ConflictException('This upload has already been published.');
        }
        return;
      }
      if (!uploadSnapshot.exists || uploadSnapshot.get('uid') !== user.uid ||
          uploadSnapshot.get('purpose') !== 'story' || uploadSnapshot.get('status') !== 'uploaded') {
        throw new NotFoundException('Upload session is unavailable.');
      }
      const upload = uploadSnapshot.data()!;
      transaction.create(storyRef, {
        uid: user.uid,
        uploadPath: upload.path,
        caption,
        expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60_000),
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.update(uploadRef, { status: 'published', publishedAt: FieldValue.serverTimestamp() });
    });
    return { id: storyRef.id };
  }

  async listStories(user: AuthenticatedUser) {
    const rows = await this.firebaseAdmin.db().collection(STORIES)
      .where('expiresAt', '>', Timestamp.now()).orderBy('expiresAt').limit(500).get();
    return Promise.all(rows.docs.map(async doc => {
      const data = doc.data() as StoryDocument;
      return {
        _id: doc.id,
        _creationTime: this.timestampMs(data.createdAt),
        expiresAt: this.timestampMs(data.expiresAt),
        caption: data.caption,
        author: await this.getProfileForUser(data.uid, user.uid),
      };
    }));
  }

  async deletePost(user: AuthenticatedUser, id: string) {
    const ref = this.firebaseAdmin.db().collection(POSTS).doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new NotFoundException('Post not found.');
    if (snapshot.get('uid') !== user.uid) throw new ForbiddenException('You can only delete your own posts.');
    await this.deleteMediaAndDoc(ref, snapshot.get('uploadPath'), true);
    return { ok: true };
  }

  async deleteStory(user: AuthenticatedUser, id: string) {
    const ref = this.firebaseAdmin.db().collection(STORIES).doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new NotFoundException('Story not found.');
    if (snapshot.get('uid') !== user.uid) throw new ForbiddenException('You can only delete your own stories.');
    await this.deleteMediaAndDoc(ref, snapshot.get('uploadPath'));
    return { ok: true };
  }

  async setAvatar(user: AuthenticatedUser, uploadId?: string) {
    await this.assertAccountActive(user.uid);
    if (!uploadId) throw new BadRequestException('Upload ID is required.');
    const profileRef = this.profileRef(user.uid);
    const uploadRef = this.firebaseAdmin.db().collection('nookSocialUploads').doc(uploadId);
    await this.firebaseAdmin.db().runTransaction(async transaction => {
      const [profile, upload] = await Promise.all([
        transaction.get(profileRef),
        transaction.get(uploadRef),
      ]);
      if (!profile.exists) throw new BadRequestException('Create your profile first.');
      if (!upload.exists || upload.get('uid') !== user.uid || upload.get('purpose') !== 'avatar') {
        throw new BadRequestException('Upload is unavailable or not ready.');
      }
      const path = upload.get('path');
      if (typeof path !== 'string') throw new BadRequestException('Upload file is missing.');
      if (upload.get('status') === 'published' && profile.get('avatarPath') === path) return;
      if (upload.get('status') !== 'uploaded') throw new BadRequestException('Upload is unavailable or not ready.');
      if (upload.get('expiresAt').toMillis() <= Date.now()) throw new BadRequestException('Upload session expired.');
      transaction.update(profileRef, {
        avatarPath: path,
        avatarVersion: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(uploadRef, { status: 'published', updatedAt: FieldValue.serverTimestamp() });
    });
    return { ok: true };
  }

  async mediaUrl(user: AuthenticatedUser, kind: string, id: string) {
    let path: string | undefined;
    if (kind === 'avatar') {
      path = (await this.profileRef(id).get()).get('avatarPath');
    } else if (kind === 'post') {
      path = (await this.firebaseAdmin.db().collection(POSTS).doc(id).get()).get('uploadPath');
    } else if (kind === 'story') {
      const story = await this.firebaseAdmin.db().collection(STORIES).doc(id).get();
      if (story.exists && story.get('expiresAt').toMillis() > Date.now()) path = story.get('uploadPath');
    } else {
      throw new BadRequestException('Unknown media type.');
    }
    if (!path) throw new NotFoundException('Media not found.');
    const [url] = await this.firebaseAdmin.storageBucket().file(path).getSignedUrl({
      action: 'read',
      expires: Date.now() + 5 * 60_000,
    });
    return { url };
  }

  async requestDeletion(user: AuthenticatedUser) {
    const ref = this.firebaseAdmin.db().collection('nookSocialDeletionRequests').doc(user.uid);
    const previous = await ref.get();
    if (previous.exists && previous.get('state') === 'complete') return { ok: true, state: 'complete' };
    await ref.set({
      uid: user.uid,
      state: 'pending',
      createdAt: previous.exists ? previous.get('createdAt') : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    try {
      await this.deleteAccountData(user);
      await ref.set({ state: 'complete', error: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { ok: true, state: 'complete' };
    } catch {
      await ref.set({ state: 'failed', error: 'We could not finish removing your Nook data. Please retry.', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      throw new InternalServerErrorException('We could not finish removing your Nook data. Please retry.');
    }
  }

  async deletionStatus(user: AuthenticatedUser) {
    const snapshot = await this.firebaseAdmin.db().collection('nookSocialDeletionRequests').doc(user.uid).get();
    return snapshot.exists ? snapshot.data() : null;
  }

  async listConversations(user: AuthenticatedUser, unreadOnly: boolean, page: number, pageSize: number) {
    const rows = await this.firebaseAdmin.db().collection('nookConversations')
      .where('participantUids', 'array-contains', user.uid).limit(500).get();
    const items = await Promise.all(rows.docs.map(async doc => {
      const data = doc.data();
      const otherUid = (data.participantUids as string[]).find(uid => uid !== user.uid) || user.uid;
      const lastRead = Number((data.lastReadBy as Record<string, number> | undefined)?.[user.uid] || 0);
      const unread = Number(data.latestSequence || 0) > lastRead && data.lastSenderUid !== user.uid;
      return {
        _id: doc.id,
        other: await this.getProfileForUser(otherUid, user.uid),
        preview: String(data.preview || ''),
        lastMessageAt: this.timestampMs(data.lastMessageAt),
        unread,
      };
    }));
    const filtered = items.filter(item => !unreadOnly || item.unread)
      .sort((left, right) => right.lastMessageAt - left.lastMessageAt);
    return this.page(filtered, page, pageSize);
  }

  async startConversation(user: AuthenticatedUser, profileId: string) {
    await this.assertAccountActive(user.uid);
    if (profileId === user.uid) throw new BadRequestException('You cannot message yourself.');
    const other = await this.profileRef(profileId).get();
    if (!other.exists) throw new NotFoundException('Profile not found.');
    const participantUids = [user.uid, profileId].sort();
    const existing = await this.firebaseAdmin.db().collection('nookConversations')
      .where('participantUids', '==', participantUids).limit(1).get();
    if (!existing.empty) return { id: existing.docs[0].id };
    const ref = this.firebaseAdmin.db().collection('nookConversations')
      .doc(createHash('sha256').update(participantUids.join(':')).digest('hex'));
    await this.firebaseAdmin.db().runTransaction(async transaction => {
      const existing = await transaction.get(ref);
      if (!existing.exists) transaction.create(ref, {
        participantUids,
        latestSequence: 0,
        lastReadBy: { [user.uid]: 0, [profileId]: 0 },
        preview: '',
        lastMessageAt: Timestamp.now(),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    return { id: ref.id };
  }

  async getConversation(user: AuthenticatedUser, id: string) {
    const snapshot = await this.requireConversation(user.uid, id);
    const data = snapshot.data()!;
    const otherUid = (data.participantUids as string[]).find(uid => uid !== user.uid) || user.uid;
    return { _id: snapshot.id, other: await this.getProfileForUser(otherUid, user.uid) };
  }

  async listMessages(user: AuthenticatedUser, id: string, page: number, pageSize: number) {
    const conversation = await this.requireConversation(user.uid, id);
    const rows = await conversation.ref.collection('messages').orderBy('sequence', 'desc').offset(page * pageSize).limit(pageSize + 1).get();
    const docs = rows.docs.slice(0, pageSize);
    const items = docs.map(doc => ({
      _id: doc.id,
      text: String(doc.get('text') || ''),
      sequence: Number(doc.get('sequence') || 0),
      _creationTime: this.timestampMs(doc.get('createdAt')),
      outgoing: doc.get('senderUid') === user.uid,
      requestId: doc.get('requestId'),
    }));
    return { items, hasMore: rows.docs.length > pageSize };
  }

  async markRead(user: AuthenticatedUser, id: string, sequence: number) {
    const conversation = await this.requireConversation(user.uid, id);
    const lastReadBy = (conversation.get('lastReadBy') || {}) as Record<string, number>;
    await conversation.ref.update({
      [`lastReadBy.${user.uid}`]: Math.max(Number(lastReadBy[user.uid] || 0), sequence),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ok: true };
  }

  async deleteAccountData(user: AuthenticatedUser) {
    const profile = await this.profileRef(user.uid).get();
    const username = profile.get('normalizedUsername');
    if (typeof username === 'string') await this.usernameRef(username).delete();
    const storage = this.firebaseAdmin.storageBucket();
    const [files] = await storage.getFiles({ prefix: `nook/${user.uid}/` });
    for (let start = 0; start < files.length; start += 50) {
      await Promise.all(files.slice(start, start + 50).map(file => file.delete({ ignoreNotFound: true })));
    }

    const db = this.firebaseAdmin.db();
    const [ownPosts, ownStories, ownUploads, ownBookmarks, followerRows, followedRows, conversations] = await Promise.all([
      db.collection(POSTS).where('uid', '==', user.uid).get(),
      db.collection(STORIES).where('uid', '==', user.uid).get(),
      db.collection('nookSocialUploads').where('uid', '==', user.uid).get(),
      db.collection(BOOKMARKS).where('uid', '==', user.uid).get(),
      db.collection(FOLLOWS).where('followerUid', '==', user.uid).get(),
      db.collection(FOLLOWS).where('followedUid', '==', user.uid).get(),
      db.collection('nookConversations').where('participantUids', 'array-contains', user.uid).get(),
    ]);
    await Promise.all(ownPosts.docs.map(doc => this.deletePostChildren(doc.ref)));

    const allPosts = await db.collection(POSTS).get();
    for (const post of allPosts.docs) {
      if (post.get('uid') === user.uid) continue;
      const [likes, comments, allComments] = await Promise.all([
        post.ref.collection('likes').where('uid', '==', user.uid).get(),
        post.ref.collection('comments').where('uid', '==', user.uid).get(),
        post.ref.collection('comments').get(),
      ]);
      const commentLikes = await Promise.all(allComments.docs.map(comment => comment.ref.collection('likes').where('uid', '==', user.uid).get()));
      await Promise.all(comments.docs.map(comment => this.deleteSubcollection(comment.ref, 'likes')));
      await this.deleteRefs([...likes.docs.map(doc => doc.ref), ...comments.docs.map(doc => doc.ref)]);
      await this.deleteRefs(commentLikes.flatMap(snapshot => snapshot.docs.map(doc => doc.ref)));
    }
    await Promise.all(conversations.docs.map(doc => this.deleteSubcollection(doc.ref, 'messages')));
    await this.deleteRefs([
      ...ownPosts.docs.map(doc => doc.ref),
      ...ownStories.docs.map(doc => doc.ref),
      ...ownUploads.docs.map(doc => doc.ref),
      ...ownBookmarks.docs.map(doc => doc.ref),
      ...followerRows.docs.map(doc => doc.ref),
      ...followedRows.docs.map(doc => doc.ref),
      ...conversations.docs.map(doc => doc.ref),
    ]);
    if (profile.exists) await profile.ref.delete();
    return { ok: true };
  }

  private async presentProfile(id: string, data: ProfileDocument, viewerUid: string) {
    const db = this.firebaseAdmin.db();
    const [followers, following, posts, followedByViewer] = await Promise.all([
      db.collection(FOLLOWS).where('followedUid', '==', id).count().get(),
      db.collection(FOLLOWS).where('followerUid', '==', id).count().get(),
      db.collection(POSTS).where('uid', '==', id).count().get(),
      db.collection(FOLLOWS).doc(`${viewerUid}_${id}`).get(),
    ]);
    return {
      _id: id,
      username: data.username,
      name: data.name,
      bio: data.bio || '',
      website: data.website || '',
      location: data.location || '',
      isOwn: id === viewerUid,
      isFollowing: followedByViewer.exists,
      isDemo: false,
      hasAvatar: Boolean(data.avatarPath),
      avatarVersion: Number(data.avatarVersion || 0),
      followersCount: followers.data().count,
      followingCount: following.data().count,
      postsCount: posts.data().count,
    };
  }

  private async getProfileForUser(id: string, viewerUid: string) {
    const snapshot = await this.profileRef(id).get();
    return snapshot.exists ? this.presentProfile(snapshot.id, snapshot.data() as ProfileDocument, viewerUid) : null;
  }

  private async presentPost(id: string, data: PostDocument, viewerUid: string) {
    const ref = this.firebaseAdmin.db().collection(POSTS).doc(id);
    const [author, likes, comments, ownLike, ownBookmark] = await Promise.all([
      this.getProfileForUser(data.uid, viewerUid),
      ref.collection('likes').count().get(),
      ref.collection('comments').count().get(),
      ref.collection('likes').doc(viewerUid).get(),
      this.firebaseAdmin.db().collection(BOOKMARKS).doc(`${viewerUid}_${id}`).get(),
    ]);
    return {
      _id: id,
      _creationTime: this.timestampMs(data.createdAt),
      caption: data.caption,
      author,
      isOwn: data.uid === viewerUid,
      isLiked: ownLike.exists,
      isBookmarked: ownBookmark.exists,
      likesCount: likes.data().count,
      commentsCount: comments.data().count,
      kind: data.kind,
      width: data.width,
      height: data.height,
      duration: data.duration,
    };
  }

  private async requirePost(id: string) {
    const snapshot = await this.firebaseAdmin.db().collection(POSTS).doc(id).get();
    if (!snapshot.exists) throw new NotFoundException('Post not found.');
    return snapshot;
  }

  private async requireConversation(uid: string, id: string) {
    const ref = this.firebaseAdmin.db().collection('nookConversations').doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new NotFoundException('Conversation not found.');
    if (!(snapshot.get('participantUids') as string[] | undefined)?.includes(uid)) {
      throw new ForbiddenException('Not authorized to access this conversation.');
    }
    return snapshot;
  }

  private async deleteMediaAndDoc(ref: FirebaseFirestore.DocumentReference, path: unknown, post = false) {
    if (typeof path === 'string') await this.firebaseAdmin.storageBucket().file(path).delete({ ignoreNotFound: true });
    if (post) await this.deletePostChildren(ref);
    await ref.delete();
  }

  private async assertAccountActive(uid: string) {
    const deletion = await this.firebaseAdmin.db().collection('nookSocialDeletionRequests').doc(uid).get();
    if (deletion.exists && ['pending', 'complete'].includes(String(deletion.get('state')))) {
      throw new ForbiddenException('This Nook account is being deleted.');
    }
  }

  private async deletePostChildren(postRef: FirebaseFirestore.DocumentReference) {
    const [likes, comments] = await Promise.all([
      postRef.collection('likes').get(),
      postRef.collection('comments').get(),
    ]);
    await Promise.all(comments.docs.map(comment => this.deleteSubcollection(comment.ref, 'likes')));
    await this.deleteRefs([...likes.docs.map(doc => doc.ref), ...comments.docs.map(doc => doc.ref)]);
  }

  private async deleteSubcollection(parent: FirebaseFirestore.DocumentReference, name: string) {
    const rows = await parent.collection(name).get();
    await this.deleteRefs(rows.docs.map(doc => doc.ref));
  }

  private async deleteRefs(refs: FirebaseFirestore.DocumentReference[]) {
    const db = this.firebaseAdmin.db();
    for (let start = 0; start < refs.length; start += 400) {
      const batch = db.batch();
      refs.slice(start, start + 400).forEach(ref => batch.delete(ref));
      await batch.commit();
    }
  }

  private profileRef(uid: string) {
    return this.firebaseAdmin.db().collection(SOCIAL).doc(uid);
  }

  private usernameRef(username: string) {
    return this.firebaseAdmin.db().collection('nookSocialUsernames').doc(username);
  }

  private followRef(followerUid: string, followedUid: string) {
    return this.firebaseAdmin.db().collection(FOLLOWS).doc(`${followerUid}_${followedUid}`);
  }

  private page<T>(items: T[], page: number, pageSize: number) {
    const safePage = Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0);
    const safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isFinite(pageSize) ? Math.floor(pageSize) : 20));
    const start = safePage * safeSize;
    return { items: items.slice(start, start + safeSize), hasMore: start + safeSize < items.length };
  }

  private normalizeUsername(value?: string) {
    const username = String(value || '').trim().toLowerCase();
    if (!USERNAME_PATTERN.test(username)) throw new BadRequestException('Username must be 3–30 letters, numbers, dots or underscores.');
    return username;
  }

  private requireText(value: unknown, label: string, maxLength: number) {
    const text = String(value || '').trim();
    if (!text || text.length > maxLength) throw new BadRequestException(`${label} must be 1–${maxLength} characters.`);
    return text;
  }

  private optionalText(value: unknown, maxLength: number) {
    const text = String(value || '').trim();
    if (text.length > maxLength) throw new BadRequestException(`Text must be ${maxLength} characters or fewer.`);
    return text;
  }

  private timestampMs(value: unknown) {
    if (value instanceof Timestamp) return value.toMillis();
    if (value instanceof Date) return value.getTime();
    return typeof value === 'number' ? value : 0;
  }

  private extensionForMime(mime: string) {
    switch (mime.toLowerCase()) {
      case 'image/jpeg': return 'jpg';
      case 'image/png': return 'png';
      case 'image/webp': return 'webp';
      case 'image/heic': return 'heic';
      case 'image/heif': return 'heif';
      case 'video/quicktime': return 'mov';
      case 'video/mp4': return 'mp4';
      default: throw new BadRequestException('Unsupported media type.');
    }
  }
}
