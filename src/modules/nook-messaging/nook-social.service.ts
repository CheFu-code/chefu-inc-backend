import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { CloudinaryStorageService } from '../../common/cloudinary-storage.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { ProfilePictureService } from '../auth/profile-picture.service';
import { postSearchTokens } from './post-search';

type ProfileDocument = {
  uid: string;
  email: string;
  username: string;
  normalizedUsername: string;
  name?: string;
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
  uploadPath?: string;
  cloudinaryUrl?: string;
  cloudinaryPublicId?: string;
  cloudinaryResourceType?: 'image' | 'video' | 'raw';
  kind: 'image' | 'video' | 'text';
  caption: string;
  width?: number;
  height?: number;
  duration?: number;
  createdAt: Timestamp;
  searchTokens?: string[];
};

type StoryDocument = {
  uid: string;
  uploadPath?: string;
  cloudinaryUrl?: string;
  cloudinaryPublicId?: string;
  cloudinaryResourceType?: 'image' | 'video' | 'raw';
  caption: string;
  expiresAt: Timestamp;
  createdAt: Timestamp;
};

const SOCIAL = 'nookSocialProfiles';
const POSTS = 'nookSocialPosts';
const STORIES = 'nookSocialStories';
const FOLLOWS = 'nookSocialFollows';
const BOOKMARKS = 'nookSocialBookmarks';
const BLOCKS = 'nookSocialBlocks';
const MAX_PAGE_SIZE = 50;
const HOME_FEED_UIDS_PER_QUERY = 30;
const USERNAME_PATTERN = /^[a-z0-9._]{3,30}$/;

@Injectable()
export class NookSocialService {
  private readonly logger = new Logger(NookSocialService.name);

  constructor(
    private readonly firebaseAdmin: FirebaseAdminService,
    private readonly profilePictureService: ProfilePictureService,
    private readonly cloudinaryStorage: CloudinaryStorageService,
  ) {}

  async profile(user: AuthenticatedUser) {
    const snapshot = await this.profileRef(user.uid).get();
    return snapshot.exists ? this.presentProfile(snapshot.id, snapshot.data() as ProfileDocument, user.uid) : null;
  }

  async createProfile(user: AuthenticatedUser, body: { username?: string }) {
    const username = this.normalizeUsername(body.username);
    const profileRef = this.profileRef(user.uid);
    const usernameRef = this.usernameRef(username);

    await this.firebaseAdmin.db().runTransaction(async transaction => {
      const [existingProfile, existingUsername] = await Promise.all([
        transaction.get(profileRef),
        transaction.get(usernameRef),
      ]);
      if (existingProfile.exists) throw new ConflictException('Your profile already exists.');
      if (existingUsername.exists) throw new ConflictException('That username is already taken.');
      const now = FieldValue.serverTimestamp();
      transaction.set(profileRef, {
        uid: user.uid,
        email: user.email,
        username,
        normalizedUsername: username,
        createdAt: now,
        updatedAt: now,
      });
      transaction.set(usernameRef, { uid: user.uid, createdAt: now });
    });

    return this.profile(user);
  }

  async updateProfile(user: AuthenticatedUser, body: { username?: string }) {
    const ref = this.profileRef(user.uid);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new NotFoundException('Create your Nook profile first.');
    const current = snapshot.data() as ProfileDocument;
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
    return this.getProfileForUser(user.uid, user.uid);
  }

  async getProfile(user: AuthenticatedUser, id: string) {
    const profile = await this.getProfileForUser(id, user.uid);
    if (!profile) return null;
    const [blockedByMe, blockingMe] = await Promise.all([
      this.blockRef(user.uid, id).get(),
      this.blockRef(id, user.uid).get(),
    ]);
    return {
      ...profile,
      isBlockedByMe: blockedByMe.exists,
      isBlockingMe: blockingMe.exists,
    };
  }

  async listBlockedUsers(user: AuthenticatedUser, page: number, pageSize: number) {
    const safePage = Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0);
    const safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isFinite(pageSize) ? Math.floor(pageSize) : 20));
    const rows = await this.firebaseAdmin.db().collection(BLOCKS)
      .where('blockerUid', '==', user.uid)
      .offset(safePage * safeSize)
      .limit(safeSize + 1)
      .get();
    const visibleRows = rows.docs.slice(0, safeSize);
    const items = await Promise.all(visibleRows.map(row =>
      this.getProfileForUser(String(row.get('blockedUid')), user.uid),
    ));
    return {
      items: items.filter((profile): profile is NonNullable<typeof profile> => profile !== null),
      hasMore: rows.docs.length > visibleRows.length,
    };
  }

  async setBlocked(user: AuthenticatedUser, profileId: string, blocked: boolean) {
    if (!profileId || profileId.length > 200 || profileId.includes('/')) {
      throw new BadRequestException('Invalid profile.');
    }
    if (profileId === user.uid) throw new BadRequestException('You cannot block yourself.');
    const db = this.firebaseAdmin.db();
    const targetRef = this.profileRef(profileId);
    const blockRef = this.blockRef(user.uid, profileId);
    const outgoingFollowRef = this.followRef(user.uid, profileId);
    const incomingFollowRef = this.followRef(profileId, user.uid);
    await db.runTransaction(async transaction => {
      const [target, existingBlock] = await Promise.all([
        transaction.get(targetRef),
        transaction.get(blockRef),
      ]);
      if (!target.exists) throw new NotFoundException('Profile not found.');
      if (blocked) {
        const [outgoingFollow, incomingFollow] = await Promise.all([
          transaction.get(outgoingFollowRef),
          transaction.get(incomingFollowRef),
        ]);
        if (!existingBlock.exists) {
          transaction.create(blockRef, {
            blockerUid: user.uid,
            blockedUid: profileId,
            createdAt: FieldValue.serverTimestamp(),
          });
        }
        if (outgoingFollow.exists) transaction.delete(outgoingFollowRef);
        if (incomingFollow.exists) transaction.delete(incomingFollowRef);
      } else if (existingBlock.exists) {
        transaction.delete(blockRef);
      }
    });
    return { blocked };
  }

  async searchProfiles(user: AuthenticatedUser, query: string, page: number, pageSize: number) {
    const normalized = query.trim().toLowerCase().replace(/^@/, '');
    const snapshot = await this.firebaseAdmin.db().collection(SOCIAL).orderBy('normalizedUsername').limit(500).get();
    const blockedUids = await this.blockedUids(user.uid);
    const profiles = await Promise.all(snapshot.docs
      .map(doc => this.presentProfile(doc.id, doc.data() as ProfileDocument, user.uid)));
    return this.page(profiles.filter(profile =>
      !blockedUids.has(profile._id) &&
      (!normalized || profile.username.includes(normalized) || profile.name.toLowerCase().includes(normalized)),
    ), page, pageSize);
  }

  async searchProfilesCursor(user: AuthenticatedUser, query: string, cursor: string | undefined, pageSize: number) {
    const normalized = String(query || '').trim().toLowerCase().replace(/^@/, '');
    if (normalized.length > 100) throw new BadRequestException('Search query must be 100 characters or fewer.');
    const safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isFinite(pageSize) ? Math.floor(pageSize) : 20));
    let profilesQuery: FirebaseFirestore.Query = this.firebaseAdmin.db().collection(SOCIAL)
      .orderBy('normalizedUsername')
      .orderBy(FieldPath.documentId());
    if (normalized) {
      profilesQuery = profilesQuery
        .where('normalizedUsername', '>=', normalized)
        .where('normalizedUsername', '<=', `${normalized}\uf8ff`);
    }
    if (cursor) {
      const position = this.decodeProfileCursor(cursor);
      profilesQuery = profilesQuery.startAfter(position.username, position.id);
    }

    const [snapshot, blockedUids] = await Promise.all([
      profilesQuery.limit(safeSize + 1).get(),
      this.blockedUids(user.uid),
    ]);
    const docs = snapshot.docs.slice(0, safeSize);
    const profiles = await Promise.all(docs.map(doc =>
      this.presentProfile(doc.id, doc.data() as ProfileDocument, user.uid),
    ));
    const items = profiles.filter(profile => !blockedUids.has(profile._id));
    const last = docs.at(-1);
    return {
      items,
      nextCursor: snapshot.docs.length > safeSize && last
        ? Buffer.from(JSON.stringify({
            username: String(last.get('normalizedUsername') || ''),
            id: last.id,
          })).toString('base64url')
        : null,
    };
  }

  async setFollow(user: AuthenticatedUser, profileId: string, following: boolean) {
    if (profileId === user.uid) throw new BadRequestException('You cannot follow your own profile.');
    const target = await this.profileRef(profileId).get();
    if (!target.exists) throw new NotFoundException('Profile not found.');
    const ref = this.followRef(user.uid, profileId);
    await this.firebaseAdmin.db().runTransaction(async transaction => {
      const [outgoingBlock, incomingBlock] = await Promise.all([
        transaction.get(this.blockRef(user.uid, profileId)),
        transaction.get(this.blockRef(profileId, user.uid)),
      ]);
      if (following && (outgoingBlock.exists || incomingBlock.exists)) {
        throw new ForbiddenException('You cannot follow this profile.');
      }
      if (following) {
        transaction.set(ref, {
          followerUid: user.uid,
          followedUid: profileId,
          createdAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      } else {
        transaction.delete(ref);
      }
    });
    return { following };
  }

  async connections(user: AuthenticatedUser, profileId: string, kind: 'followers' | 'following', page: number, pageSize: number) {
    const field = kind === 'followers' ? 'followedUid' : 'followerUid';
    const uidField = kind === 'followers' ? 'followerUid' : 'followedUid';
    const rows = await this.firebaseAdmin.db().collection(FOLLOWS).where(field, '==', profileId).limit(500).get();
    const blockedUids = await this.blockedUids(user.uid);
    rows.docs.sort((left, right) => this.timestampMs(right.get('createdAt')) - this.timestampMs(left.get('createdAt')));
    const safePage = Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0);
    const safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isFinite(pageSize) ? Math.floor(pageSize) : 20));
    const start = safePage * safeSize;
    const selected = rows.docs.filter(row => !blockedUids.has(String(row.get(uidField))))
      .slice(start, start + safeSize + 1);
    const profiles = await Promise.all(selected.slice(0, safeSize).map(row =>
      this.getProfileForUser(String(row.get(uidField)), user.uid),
    ));
    return { items: profiles.filter(Boolean), hasMore: selected.length > safeSize };
  }

  async listPosts(user: AuthenticatedUser, feed: 'home' | 'explore' | 'profile', profileId: string | undefined, page: number, pageSize: number) {
    const follows = feed === 'home'
      ? await this.firebaseAdmin.db().collection(FOLLOWS).where('followerUid', '==', user.uid).limit(500).get()
      : null;
    const allowed = follows ? new Set([user.uid, ...follows.docs.map(doc => String(doc.get('followedUid')))]) : null;
    const blockedUids = await this.blockedUids(user.uid);
    const query = this.firebaseAdmin.db().collection(POSTS).orderBy('createdAt', 'desc').limit(1000);
    const snapshot = await query.get();
    const filtered = snapshot.docs.filter(doc => {
      const data = doc.data() as PostDocument;
      if (blockedUids.has(data.uid)) return false;
      if (feed === 'profile') return data.uid === profileId;
      if (allowed) return allowed.has(data.uid);
      return true;
    });
    const postRows = await Promise.all(filtered.map(doc =>
      this.presentPost(doc.id, doc.data() as PostDocument, user.uid),
    ));
    return this.page(postRows, page, pageSize);
  }

  async searchExplorePosts(user: AuthenticatedUser, query: string, cursor: string | undefined, pageSize: number) {
    const normalizedQuery = String(query || '').trim();
    if (normalizedQuery.length > 100) throw new BadRequestException('Search query must be 100 characters or fewer.');
    const tokens = postSearchTokens(normalizedQuery).slice(0, 5);
    const safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isFinite(pageSize) ? Math.floor(pageSize) : 20));
    if (normalizedQuery && !tokens.length) return { items: [], nextCursor: null };
    let postsQuery: FirebaseFirestore.Query = this.firebaseAdmin.db().collection(POSTS);
    if (tokens.length) postsQuery = postsQuery.where('searchTokens', 'array-contains-any', tokens);
    postsQuery = postsQuery
      .orderBy('createdAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc');

    if (cursor) {
      const position = this.decodePostCursor(cursor);
      postsQuery = postsQuery.startAfter(
        new Timestamp(position.seconds, position.nanoseconds),
        position.id,
      );
    }

    const [snapshot, blockedUids] = await Promise.all([
      postsQuery.limit(Math.min(100, safeSize * 3)).get(),
      this.blockedUids(user.uid),
    ]);
    const filteredDocs = snapshot.docs.filter(doc =>
      !blockedUids.has(String(doc.get('uid') || '')),
    );
    const docs = filteredDocs.slice(0, safeSize);
    const items = await this.presentPosts(docs, user.uid);
    const last = docs.at(-1);
    const hasMore = filteredDocs.length > safeSize || snapshot.docs.length === Math.min(100, safeSize * 3);
    return {
      items,
      nextCursor: hasMore && last
        ? Buffer.from(JSON.stringify({
            seconds: (last.get('createdAt') as Timestamp).seconds,
            nanoseconds: (last.get('createdAt') as Timestamp).nanoseconds,
            id: last.id,
          })).toString('base64url')
        : null,
    };
  }

  async listHomeFeedCursor(user: AuthenticatedUser, cursor: string | undefined, pageSize: number) {
    const safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isFinite(pageSize) ? Math.floor(pageSize) : 20));
    const follows = await this.firebaseAdmin.db().collection(FOLLOWS)
      .where('followerUid', '==', user.uid)
      .limit(500)
      .get();
    const blockedUids = await this.blockedUids(user.uid);
    const followedUids = [...new Set([
      user.uid,
      ...follows.docs
        .map(doc => String(doc.get('followedUid') || ''))
        .filter(uid => Boolean(uid) && !blockedUids.has(uid)),
    ])];
    const position = cursor ? this.decodePostCursor(cursor) : undefined;
    const chunks: string[][] = [];
    for (let start = 0; start < followedUids.length; start += HOME_FEED_UIDS_PER_QUERY) {
      chunks.push(followedUids.slice(start, start + HOME_FEED_UIDS_PER_QUERY));
    }

    const snapshots = await Promise.all(chunks.map(async uids => {
      let postsQuery: FirebaseFirestore.Query = this.firebaseAdmin.db().collection(POSTS)
        .where('uid', 'in', uids)
        .orderBy('createdAt', 'desc')
        .orderBy(FieldPath.documentId(), 'desc');
      if (position) {
        postsQuery = postsQuery.startAfter(
          new Timestamp(position.seconds, position.nanoseconds),
          position.id,
        );
      }
      return postsQuery.limit(safeSize + 1).get();
    }));
    const candidates = snapshots.flatMap(snapshot => snapshot.docs)
      .sort((left, right) => {
        const leftCreatedAt = left.get('createdAt') as Timestamp;
        const rightCreatedAt = right.get('createdAt') as Timestamp;
        return rightCreatedAt.seconds - leftCreatedAt.seconds ||
          rightCreatedAt.nanoseconds - leftCreatedAt.nanoseconds ||
          right.id.localeCompare(left.id);
      });
    const docs = candidates.slice(0, safeSize);
    const items = await this.presentPosts(docs, user.uid);
    const last = docs.at(-1);
    return {
      items,
      nextCursor: candidates.length > safeSize && last
        ? Buffer.from(JSON.stringify({
            seconds: (last.get('createdAt') as Timestamp).seconds,
            nanoseconds: (last.get('createdAt') as Timestamp).nanoseconds,
            id: last.id,
          })).toString('base64url')
        : null,
    };
  }

  async listProfilePostsCursor(user: AuthenticatedUser, profileId: string, cursor: string | undefined, pageSize: number) {
    const safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isFinite(pageSize) ? Math.floor(pageSize) : 20));
    let postsQuery: FirebaseFirestore.Query = this.firebaseAdmin.db().collection(POSTS)
      .where('uid', '==', profileId)
      .orderBy('createdAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc');
    if (cursor) {
      const position = this.decodePostCursor(cursor);
      postsQuery = postsQuery.startAfter(
        new Timestamp(position.seconds, position.nanoseconds),
        position.id,
      );
    }

    if (await this.isBlockedPair(user.uid, profileId)) return { items: [], nextCursor: null };
    const snapshot = await postsQuery.limit(safeSize + 1).get();
    const docs = snapshot.docs.slice(0, safeSize);
    const items = await this.presentPosts(docs, user.uid);
    const last = docs.at(-1);
    return {
      items,
      nextCursor: snapshot.docs.length > safeSize && last
        ? Buffer.from(JSON.stringify({
            seconds: (last.get('createdAt') as Timestamp).seconds,
            nanoseconds: (last.get('createdAt') as Timestamp).nanoseconds,
            id: last.id,
          })).toString('base64url')
        : null,
    };
  }

  async listBookmarkedPosts(user: AuthenticatedUser, page: number, pageSize: number) {
    const safePage = Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0);
    const safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isFinite(pageSize) ? Math.floor(pageSize) : 20));
    const start = safePage * safeSize;
    const end = start + safeSize;
    const bookmarks = await this.firebaseAdmin.db().collection(BOOKMARKS)
      .where('uid', '==', user.uid)
      .limit(1000)
      .get();
    const blockedUids = await this.blockedUids(user.uid);
    const ordered = bookmarks.docs
      .slice()
      .sort((left, right) => this.timestampMs(right.get('createdAt')) - this.timestampMs(left.get('createdAt')));
    const savedPosts: Array<{ id: string; data: PostDocument }> = [];
    let cursor = 0;

    while (cursor < ordered.length && savedPosts.length <= end) {
      const batch = ordered.slice(cursor, cursor + Math.min(50, end + 1 - savedPosts.length));
      cursor += batch.length;
      const posts = await Promise.all(batch.map(async bookmark => {
        const postId = String(bookmark.get('postId') || '');
        if (!postId) return null;
        const post = await this.firebaseAdmin.db().collection(POSTS).doc(postId).get();
        return post.exists && !blockedUids.has(String(post.get('uid') || ''))
          ? { id: post.id, data: post.data() as PostDocument }
          : null;
      }));
      savedPosts.push(...posts.filter((post): post is { id: string; data: PostDocument } => post !== null));
    }

    const items = await Promise.all(savedPosts.slice(start, end).map(post =>
      this.presentPost(post.id, post.data, user.uid),
    ));
    return { items, hasMore: savedPosts.length > end || cursor < ordered.length };
  }

  async getPost(user: AuthenticatedUser, id: string) {
    const snapshot = await this.firebaseAdmin.db().collection(POSTS).doc(id).get();
    if (
      snapshot.exists &&
      await this.isBlockedPair(user.uid, String(snapshot.get('uid') || ''))
    ) {
      throw new NotFoundException('Post not found.');
    }
    return snapshot.exists ? this.presentPost(snapshot.id, snapshot.data() as PostDocument, user.uid) : null;
  }

  async editPost(user: AuthenticatedUser, id: string, body: { caption?: string }) {
    if (typeof body.caption !== 'string') {
      throw new BadRequestException('A caption is required.');
    }
    const caption = body.caption.trim();
    if (caption.length > 2200) {
      throw new BadRequestException('Caption must be 2,200 characters or fewer.');
    }

    const ref = this.firebaseAdmin.db().collection(POSTS).doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new NotFoundException('Post not found.');
    if (snapshot.get('uid') !== user.uid) {
      throw new ForbiddenException('You can only edit your own posts.');
    }
    if (snapshot.get('kind') === 'text' && !caption) {
      throw new BadRequestException('Text posts cannot be empty.');
    }
    await ref.update({ caption, updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  }

  async setPostLike(user: AuthenticatedUser, postId: string, liked: boolean) {
    const post = await this.requirePost(user.uid, postId);
    const ref = this.firebaseAdmin.db().collection(POSTS).doc(postId).collection('likes').doc(user.uid);
    if (liked) await ref.set({ uid: user.uid, createdAt: FieldValue.serverTimestamp() }, { merge: true });
    else await ref.delete();
    return { liked, uid: post.get('uid') };
  }

  async setBookmark(user: AuthenticatedUser, postId: string, saved: boolean) {
    await this.requirePost(user.uid, postId);
    const ref = this.firebaseAdmin.db().collection(BOOKMARKS).doc(`${user.uid}_${postId}`);
    if (saved) await ref.set({ uid: user.uid, postId, createdAt: FieldValue.serverTimestamp() }, { merge: true });
    else await ref.delete();
    return { saved };
  }

  async isBookmarked(user: AuthenticatedUser, postId: string) {
    return (await this.firebaseAdmin.db().collection(BOOKMARKS).doc(`${user.uid}_${postId}`).get()).exists;
  }

  async comments(user: AuthenticatedUser, postId: string, order: 'asc' | 'desc', page: number, pageSize: number) {
    await this.requirePost(user.uid, postId);
    const safePage = Math.max(0, Number.isFinite(page) ? Math.floor(page) : 0);
    const safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isFinite(pageSize) ? Math.floor(pageSize) : 20));
    const blockedUids = await this.blockedUids(user.uid);
    const rows = await this.firebaseAdmin.db().collection(POSTS).doc(postId).collection('comments')
      .orderBy('createdAt', order)
      .offset(safePage * safeSize)
      .limit(safeSize + 1)
      .get();
    const docs = rows.docs.slice(0, safeSize)
      .filter(doc => !blockedUids.has(String(doc.get('uid') || '')));
    const items = await Promise.all(docs.map(async doc => {
      const comment = doc.data();
      const author = await this.getProfileForUser(String(comment.uid), user.uid);
      const liked = await doc.ref.collection('likes').doc(user.uid).get();
      return {
        _id: doc.id,
        _creationTime: this.timestampMs(comment.createdAt),
        text: String(comment.text || ''),
        parentId: typeof comment.parentId === 'string' ? comment.parentId : undefined,
        author,
        isOwn: comment.uid === user.uid,
        isLiked: liked.exists,
      };
    }));
    return { items, hasMore: rows.docs.length > safeSize };
  }

  async addComment(user: AuthenticatedUser, postId: string, body: { text?: string; requestId?: string; parentId?: string }) {
    const text = this.requireText(body.text, 'Comment', 2000);
    const requestId = body.requestId?.trim();
    if (!requestId || requestId.length > 100) throw new BadRequestException('A valid request ID is required.');
    await this.requirePost(user.uid, postId);
    const parentId = body.parentId?.trim() || undefined;
    if (parentId) {
      const parent = await this.firebaseAdmin.db().collection(POSTS).doc(postId)
        .collection('comments').doc(parentId).get();
      if (!parent.exists) throw new NotFoundException('Reply target comment not found.');
    }
    const id = createHash('sha256').update(`${user.uid}:${requestId}`).digest('hex');
    const ref = this.firebaseAdmin.db().collection(POSTS).doc(postId).collection('comments').doc(id);
    await this.firebaseAdmin.db().runTransaction(async transaction => {
      const existing = await transaction.get(ref);
      if (existing.exists) {
        if (
          existing.get('uid') !== user.uid ||
          existing.get('text') !== text ||
          (existing.get('parentId') || undefined) !== parentId
        ) {
          throw new ConflictException('Retry does not match the original comment.');
        }
        return;
      }
      transaction.create(ref, {
        uid: user.uid,
        text,
        requestId,
        parentId,
        createdAt: FieldValue.serverTimestamp(),
      });
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

  async editComment(user: AuthenticatedUser, postId: string, commentId: string, body: { text?: string }) {
    const text = this.requireText(body.text, 'Comment', 2000);
    const ref = this.firebaseAdmin.db().collection(POSTS).doc(postId)
      .collection('comments').doc(commentId);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new NotFoundException('Comment not found.');
    if (snapshot.get('uid') !== user.uid) {
      throw new ForbiddenException('You can only edit your own comments.');
    }
    await ref.update({ text, updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  }

  async setCommentLike(user: AuthenticatedUser, postId: string, commentId: string, liked: boolean) {
    const comment = this.firebaseAdmin.db().collection(POSTS).doc(postId).collection('comments').doc(commentId);
    if (!(await comment.get()).exists) throw new NotFoundException('Comment not found.');
    const ref = comment.collection('likes').doc(user.uid);
    if (liked) await ref.set({ uid: user.uid, createdAt: FieldValue.serverTimestamp() }, { merge: true });
    else await ref.delete();
    return { liked };
  }

  async createUpload(user: AuthenticatedUser, body: {
    purpose?: 'post' | 'story';
    kind?: 'image';
    width?: number;
    height?: number;
  }) {
    if (!['post', 'story'].includes(String(body.purpose)) || body.kind !== 'image') {
      throw new BadRequestException('Invalid upload purpose or media type.');
    }
    const width = Number(body.width);
    const height = Number(body.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 30_000 || height > 30_000) {
      throw new BadRequestException('Valid media dimensions are required.');
    }
    const id = randomUUID();
    await this.firebaseAdmin.db().collection('nookSocialUploads').doc(id).create({
      uid: user.uid,
      purpose: body.purpose,
      kind: body.kind,
      width,
      height,
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
    if (snapshot.get('status') === 'uploaded' &&
        (typeof snapshot.get('path') === 'string' || typeof snapshot.get('cloudinaryPublicId') === 'string')) {
      return { ok: true };
    }
    if (snapshot.get('status') !== 'pending') throw new NotFoundException('Upload session is unavailable.');
    if (snapshot.get('expiresAt').toMillis() <= Date.now()) throw new BadRequestException('Upload session expired.');
    const purpose = snapshot.get('purpose') as string;
    const kind = snapshot.get('kind') as string;
    if (kind !== 'image') {
      throw new BadRequestException('Video posts are not supported. Choose a photo.');
    }
    const maxBytes = 10;
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    if (!buffer.length || buffer.length > maxBytes * 1024 * 1024 || !allowed.includes(mimeType.toLowerCase())) {
      throw new BadRequestException(`Choose a supported file under ${maxBytes} MB.`);
    }
    const resourceType = 'image';
    const uploaded = await this.cloudinaryStorage.uploadBuffer(buffer, {
      public_id: `chefu/nook/${user.uid}/${id}`,
      resource_type: resourceType,
      overwrite: false,
      flags: 'strip_profile',
      tags: ['chefu', 'nook', purpose, kind],
      context: { content_type: mimeType.toLowerCase() },
    });
    try {
      await ref.update({
        cloudinaryUrl: uploaded.secure_url,
        cloudinaryPublicId: uploaded.public_id,
        cloudinaryResourceType: resourceType,
        bytes: buffer.length,
        contentType: mimeType.toLowerCase(),
        status: 'uploaded',
        updatedAt: FieldValue.serverTimestamp(),
      });
    } catch (error) {
      try {
        await this.cloudinaryStorage.delete(uploaded.public_id, resourceType);
      } catch (cleanupError) {
        this.logger.error(`Failed to clean up orphaned Nook Cloudinary asset ${uploaded.public_id}.`, cleanupError);
      }
      throw error;
    }
    return { ok: true };
  }

  async cancelUpload(user: AuthenticatedUser, id: string) {
    const ref = this.firebaseAdmin.db().collection('nookSocialUploads').doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) return { ok: true };
    if (snapshot.get('uid') !== user.uid) throw new ForbiddenException('Upload does not belong to you.');
    if (!['pending', 'uploaded'].includes(String(snapshot.get('status')))) return { ok: true };
    const path = snapshot.get('path');
    const publicId = snapshot.get('cloudinaryPublicId');
    if (typeof publicId === 'string') {
      const resourceType = snapshot.get('cloudinaryResourceType');
      if (resourceType !== 'image' && resourceType !== 'video' && resourceType !== 'raw') {
        throw new BadRequestException('Upload media metadata is invalid.');
      }
      await this.cloudinaryStorage.delete(publicId, resourceType);
    } else if (typeof path === 'string') {
      await this.firebaseAdmin.storageBucket().file(path).delete({ ignoreNotFound: true });
    }
    await ref.delete();
    return { ok: true };
  }

  async publishPost(user: AuthenticatedUser, body: { uploadId?: string; caption?: string; requestId?: string }) {
    const profile = await this.profileRef(user.uid).get();
    if (!profile.exists) throw new BadRequestException('Create your profile first.');
    const caption = String(body.caption || '').trim();
    if (caption.length > 2200) throw new BadRequestException('Caption must be 2,200 characters or fewer.');
    if (!body.uploadId) {
      const requestId = String(body.requestId || '').trim();
      if (!caption || !requestId || requestId.length > 100) {
        throw new BadRequestException('Write text for your post and try again.');
      }
      const postId = `text_${createHash('sha256').update(`${user.uid}:${requestId}`).digest('hex')}`;
      const postRef = this.firebaseAdmin.db().collection(POSTS).doc(postId);
      await this.firebaseAdmin.db().runTransaction(async transaction => {
        const existingPost = await transaction.get(postRef);
        if (existingPost.exists) {
          if (
            existingPost.get('uid') !== user.uid ||
            existingPost.get('kind') !== 'text' ||
            existingPost.get('caption') !== caption
          ) {
            throw new ConflictException('This post request has already been used.');
          }
          return;
        }
        transaction.create(postRef, {
          uid: user.uid,
          kind: 'text',
          caption,
          searchTokens: postSearchTokens(caption),
          createdAt: FieldValue.serverTimestamp(),
        });
      });
      return { id: postRef.id };
    }
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
          uploadSnapshot.get('purpose') !== 'post' || uploadSnapshot.get('status') !== 'uploaded' ||
          uploadSnapshot.get('kind') !== 'image') {
        throw new NotFoundException('Upload session is unavailable.');
      }
      const upload = uploadSnapshot.data()!;
      transaction.create(postRef, {
        uid: user.uid,
        uploadPath: upload.path,
        cloudinaryUrl: upload.cloudinaryUrl,
        cloudinaryPublicId: upload.cloudinaryPublicId,
        cloudinaryResourceType: upload.cloudinaryResourceType,
        kind: upload.kind,
        caption,
        width: upload.width,
        height: upload.height,
        searchTokens: postSearchTokens(caption),
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
        cloudinaryUrl: upload.cloudinaryUrl,
        cloudinaryPublicId: upload.cloudinaryPublicId,
        cloudinaryResourceType: upload.cloudinaryResourceType,
        caption,
        expiresAt: Timestamp.fromMillis(Date.now() + 24 * 60 * 60_000),
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.update(uploadRef, { status: 'published', publishedAt: FieldValue.serverTimestamp() });
    });
    return { id: storyRef.id };
  }

  async listStories(user: AuthenticatedUser) {
    const blockedUids = await this.blockedUids(user.uid);
    const rows = await this.firebaseAdmin.db().collection(STORIES)
      .where('expiresAt', '>', Timestamp.now()).orderBy('expiresAt').limit(500).get();
    return Promise.all(rows.docs.filter(doc => !blockedUids.has(String(doc.get('uid') || ''))).map(async doc => {
      const data = doc.data() as StoryDocument;
      return {
        _id: doc.id,
        _creationTime: this.timestampMs(data.createdAt),
        expiresAt: this.timestampMs(data.expiresAt),
        caption: data.caption,
        ...(data.uid === user.uid
          ? { viewerCount: Number(doc.get('viewerCount') || 0) }
          : {}),
        author: await this.getProfileForUser(data.uid, user.uid),
      };
    }));
  }

  async createPresenceToken(user: AuthenticatedUser) {
    const customToken = await this.firebaseAdmin
      .auth()
      .createCustomToken(user.uid, { nook: true });
    return { customToken };
  }

  async recordStoryView(user: AuthenticatedUser, id: string) {
    const storyRef = this.firebaseAdmin.db().collection(STORIES).doc(id);
    const viewerRef = storyRef.collection('views').doc(user.uid);
    return this.firebaseAdmin.db().runTransaction(async transaction => {
      const story = await transaction.get(storyRef);
      if (!story.exists) throw new NotFoundException('Story not found.');
      const expiresAt = story.get('expiresAt') as Timestamp | undefined;
      if (!expiresAt || expiresAt.toMillis() <= Date.now()) {
        throw new NotFoundException('Story has expired.');
      }
      if (story.get('uid') === user.uid) {
        return { viewed: false, viewerCount: Number(story.get('viewerCount') || 0) };
      }
      if (await this.isBlockedPair(user.uid, String(story.get('uid') || ''))) {
        throw new NotFoundException('Story not found.');
      }

      const existingView = await transaction.get(viewerRef);
      const viewerCount = Number(story.get('viewerCount') || 0);
      if (existingView.exists) return { viewed: false, viewerCount };

      transaction.create(viewerRef, { viewedAt: FieldValue.serverTimestamp() });
      transaction.update(storyRef, { viewerCount: FieldValue.increment(1) });
      return { viewed: true, viewerCount: viewerCount + 1 };
    });
  }

  async listStoryViewers(user: AuthenticatedUser, id: string) {
    const storyRef = this.firebaseAdmin.db().collection(STORIES).doc(id);
    const story = await storyRef.get();
    if (!story.exists) throw new NotFoundException('Story not found.');
    if (story.get('uid') !== user.uid) {
      throw new ForbiddenException('You can only view viewers of your own stories.');
    }
    const expiresAt = story.get('expiresAt') as Timestamp | undefined;
    if (!expiresAt || expiresAt.toMillis() <= Date.now()) {
      throw new NotFoundException('Story has expired.');
    }

    const viewerRows = await storyRef
      .collection('views')
      .orderBy('viewedAt', 'desc')
      .limit(101)
      .get();
    const blockedUids = await this.blockedUids(user.uid);
    const visibleRows = viewerRows.docs.filter(row => !blockedUids.has(row.id)).slice(0, 100);
    const items = await Promise.all(visibleRows.map(async viewerRow => {
      const profile = await this.getProfileForUser(viewerRow.id, user.uid);
      return profile
        ? { ...profile, viewedAt: this.timestampMs(viewerRow.get('viewedAt')) }
        : null;
    }));
    return {
      items: items.filter((profile): profile is NonNullable<typeof profile> => profile !== null),
      hasMore: viewerRows.size > visibleRows.length,
    };
  }

  async deletePost(user: AuthenticatedUser, id: string) {
    const ref = this.firebaseAdmin.db().collection(POSTS).doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new NotFoundException('Post not found.');
    if (snapshot.get('uid') !== user.uid) throw new ForbiddenException('You can only delete your own posts.');
    await this.deleteMediaAndDoc(ref, snapshot.data() as PostDocument, true);
    return { ok: true };
  }

  async deleteStory(user: AuthenticatedUser, id: string) {
    const ref = this.firebaseAdmin.db().collection(STORIES).doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new NotFoundException('Story not found.');
    if (snapshot.get('uid') !== user.uid) throw new ForbiddenException('You can only delete your own stories.');
    await this.deleteMediaAndDoc(ref, snapshot.data() as StoryDocument);
    return { ok: true };
  }

  async mediaUrl(user: AuthenticatedUser, kind: string, id: string) {
    let path: string | undefined;
    let cloudinaryUrl: string | undefined;
    if (kind === 'avatar') {
      const profile = await this.profileRef(id).get();
      if (!profile.exists) throw new NotFoundException('Profile not found.');
      const avatarUrl = await this.centralizeLegacyAvatar(
        id,
        String(profile.get('email') || ''),
        profile.get('avatarPath'),
      );
      if (avatarUrl) return { url: avatarUrl };
      throw new NotFoundException('Media not found.');
    } else if (kind === 'post') {
      const post = await this.firebaseAdmin.db().collection(POSTS).doc(id).get();
      if (!post.exists || await this.isBlockedPair(user.uid, String(post.get('uid') || ''))) {
        throw new NotFoundException('Media not found.');
      }
      path = post.get('uploadPath');
      cloudinaryUrl = post.get('cloudinaryUrl');
    } else if (kind === 'story') {
      const story = await this.firebaseAdmin.db().collection(STORIES).doc(id).get();
      if (
        story.exists &&
        story.get('expiresAt').toMillis() > Date.now() &&
        !await this.isBlockedPair(user.uid, String(story.get('uid') || ''))
      ) {
        path = story.get('uploadPath');
        cloudinaryUrl = story.get('cloudinaryUrl');
      }
    } else {
      throw new BadRequestException('Unknown media type.');
    }
    if (typeof cloudinaryUrl === 'string' && cloudinaryUrl) return { url: cloudinaryUrl };
    if (!path) throw new NotFoundException('Media not found.');
    const [url] = await this.firebaseAdmin.storageBucket().file(path).getSignedUrl({
      action: 'read',
      expires: Date.now() + 5 * 60_000,
    });
    return { url };
  }

  async listConversations(user: AuthenticatedUser, unreadOnly: boolean, page: number, pageSize: number) {
    const rows = await this.firebaseAdmin.db().collection('nookConversations')
      .where('participantUids', 'array-contains', user.uid).limit(500).get();
    const blockedUids = await this.blockedUids(user.uid);
    const conversations = rows.docs.map(doc => {
      const data = doc.data();
      const otherUid = (data.participantUids as string[]).find(uid => uid !== user.uid) || user.uid;
      const lastRead = Number((data.lastReadBy as Record<string, number> | undefined)?.[user.uid] || 0);
      const latestSequence = Number(data.latestSequence || 0);
      const storedUnreadCount = (data.unreadCountBy as Record<string, number> | undefined)?.[user.uid];
      const hasStoredUnreadCount = Number.isFinite(storedUnreadCount);
      const unreadCount = hasStoredUnreadCount
        ? Math.max(0, Number(storedUnreadCount))
        : latestSequence > lastRead && data.lastSenderUid !== user.uid
          ? 1
          : 0;
      return {
        _id: doc.id,
        otherUid,
        preview: ((data.previewDeletedForUids as string[] | undefined) || []).includes(user.uid)
          ? 'Message deleted for you.'
          : String(data.preview || ''),
        previewIsOwn: data.lastSenderUid === user.uid,
        lastMessageAt: this.timestampMs(data.lastMessageAt),
        unread: unreadCount > 0,
        unreadCount,
        unreadCountExact: hasStoredUnreadCount,
      };
    });
    const filtered = conversations.filter(item =>
      !blockedUids.has(item.otherUid) && (!unreadOnly || item.unread),
    )
      .sort((left, right) => right.lastMessageAt - left.lastMessageAt);
    const paged = this.page(filtered, page, pageSize);
    const items = await Promise.all(paged.items.map(async ({ otherUid, ...conversation }) => ({
      ...conversation,
      other: await this.getProfileForUser(otherUid, user.uid),
    })));
    return { items, hasMore: paged.hasMore };
  }

  async startConversation(user: AuthenticatedUser, profileId: string) {
    if (profileId === user.uid) throw new BadRequestException('You cannot message yourself.');
    const other = await this.profileRef(profileId).get();
    if (!other.exists) throw new NotFoundException('Profile not found.');
    if (await this.isBlockedPair(user.uid, profileId)) {
      throw new ForbiddenException('You cannot message this profile.');
    }
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
        unreadCountBy: { [user.uid]: 0, [profileId]: 0 },
        requestStatus: 'pending',
        requesterUid: user.uid,
        requestMessageCount: 0,
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
    const requestStatus = data.requestStatus;
    return {
      _id: snapshot.id,
      other: await this.getProfileForUser(otherUid, user.uid),
      messageRequest:
        requestStatus === 'pending' || requestStatus === 'accepted' || requestStatus === 'declined'
          ? {
            status: requestStatus,
            isRequester: data.requesterUid === user.uid,
            sentCount: Number(data.requestMessageCount || 0),
          }
          : null,
    };
  }

  async respondToConversationRequest(
    user: AuthenticatedUser,
    id: string,
    decision: 'accepted' | 'declined',
  ) {
    await this.requireConversation(user.uid, id);
    const ref = this.firebaseAdmin.db().collection('nookConversations').doc(id);
    const participantUids = await this.firebaseAdmin.db().runTransaction(async transaction => {
      const conversation = await transaction.get(ref);
      if (!conversation.exists) throw new NotFoundException('Conversation not found.');
      const participants = conversation.get('participantUids') as string[] | undefined;
      if (!participants?.includes(user.uid)) {
        throw new ForbiddenException('Not authorized to access this conversation.');
      }
      if (conversation.get('requestStatus') !== 'pending') {
        throw new ConflictException('This message request is no longer pending.');
      }
      if (conversation.get('requesterUid') === user.uid) {
        throw new ForbiddenException('You cannot respond to your own message request.');
      }
      transaction.update(ref, {
        requestStatus: decision,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return participants;
    });
    await Promise.all(participantUids.map(async uid => {
      try {
        await this.firebaseAdmin.publishNookChatEvent(uid, id, 'message', 0);
      } catch (error) {
        this.logger.error(
          `Failed to publish Nook request event for conversation ${id} to participant ${uid}.`,
          error,
        );
      }
    }));
    return { status: decision };
  }

  async listMessages(user: AuthenticatedUser, id: string, page: number, pageSize: number) {
    const conversation = await this.requireConversation(user.uid, id);
    const rows = await conversation.ref.collection('messages').orderBy('sequence', 'desc').offset(page * pageSize).limit(pageSize + 1).get();
    const docs = rows.docs.slice(0, pageSize);
    const participants = conversation.get('participantUids') as string[];
    const otherUid = participants.find(participantUid => participantUid !== user.uid);
    const deliveryBatch = this.firebaseAdmin.db().batch();
    const delivered = new Set<string>();
    const newlyDeliveredSequences = new Map<string, number>();
    for (const doc of docs) {
      const deliveredToUids = (doc.get('deliveredToUids') as string[] | undefined) || [];
      if (doc.get('senderUid') === user.uid) {
        if (otherUid && deliveredToUids.includes(otherUid)) delivered.add(doc.id);
      } else if (!deliveredToUids.includes(user.uid)) {
        deliveryBatch.update(doc.ref, {
          deliveredToUids: FieldValue.arrayUnion(user.uid),
        });
        newlyDeliveredSequences.set(
          String(doc.get('senderUid') || ''),
          Math.max(
            newlyDeliveredSequences.get(String(doc.get('senderUid') || '')) || 0,
            Number(doc.get('sequence') || 0),
          ),
        );
      }
    }
    if (newlyDeliveredSequences.size) {
      await deliveryBatch.commit();
      await Promise.all([...newlyDeliveredSequences.entries()]
        .filter(([senderUid]) => senderUid)
        .map(async ([senderUid, sequence]) => {
        try {
          await this.firebaseAdmin.publishNookChatEvent(
            senderUid,
            id,
            'delivery',
            sequence,
          );
        } catch (error) {
          this.logger.error(
            `Failed to publish Nook delivery event for conversation ${id} to participant ${senderUid}.`,
            error,
          );
        }
      }));
    }
    const now = Date.now();
    const items = docs.map(doc => {
      const deletedForMe =
        ((doc.get('deletedForUids') as string[] | undefined) || []).includes(user.uid);
      const deletedForEveryone = Boolean(doc.get('deletedForEveryone'));
      const createdAt = this.timestampMs(doc.get('createdAt'));
      const outgoing = doc.get('senderUid') === user.uid;
      return {
        _id: doc.id,
        text: deletedForMe || deletedForEveryone
          ? deletedForEveryone
            ? 'This message was deleted for everyone.'
            : 'This message was deleted for me.'
          : String(doc.get('text') || ''),
        sequence: Number(doc.get('sequence') || 0),
        _creationTime: createdAt,
        outgoing,
        edited: Boolean(doc.get('editedAt')),
        canDeleteForEveryone:
          outgoing &&
          !deletedForMe &&
          !deletedForEveryone &&
          createdAt > 0 &&
          createdAt <= now &&
          now - createdAt <= 2 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000,
        deletedForMe,
        deletedForEveryone,
        delivered: delivered.has(doc.id),
        requestId: doc.get('requestId'),
        reactions: deletedForMe || deletedForEveryone
          ? []
          : this.summarizeMessageReactions(
            (doc.get('reactionsBy') as Record<string, string> | undefined) || {},
            user.uid,
          ),
        replyTo: doc.get('replyTo')
          ? {
            id: String((doc.get('replyTo') as { messageId?: string }).messageId || ''),
            text: String((doc.get('replyTo') as { text?: string }).text || ''),
            outgoing:
              (doc.get('replyTo') as { senderUid?: string }).senderUid === user.uid,
          }
          : undefined,
      };
    });
    return { items, hasMore: rows.docs.length > pageSize };
  }

  private summarizeMessageReactions(
    reactionsBy: Record<string, string>,
    userId: string,
  ) {
    const counts = new Map<string, number>();
    for (const emoji of Object.values(reactionsBy)) {
      counts.set(emoji, (counts.get(emoji) || 0) + 1);
    }
    return [...counts.entries()].map(([emoji, count]) => ({
      emoji,
      count,
      reacted: reactionsBy[userId] === emoji,
    }));
  }

  async markRead(user: AuthenticatedUser, id: string, sequence: number) {
    const conversationRef = this.firebaseAdmin.db().collection('nookConversations').doc(id);
    await this.firebaseAdmin.db().runTransaction(async transaction => {
      const conversation = await transaction.get(conversationRef);
      if (!conversation.exists) throw new NotFoundException('Conversation not found.');
      if (!(conversation.get('participantUids') as string[] | undefined)?.includes(user.uid)) {
        throw new ForbiddenException('Not authorized to access this conversation.');
      }
      const latestSequence = Number(conversation.get('latestSequence') || 0);
      const lastReadBy = (conversation.get('lastReadBy') || {}) as Record<string, number>;
      const updates: Record<string, unknown> = {
        [`lastReadBy.${user.uid}`]: Math.max(Number(lastReadBy[user.uid] || 0), sequence),
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (sequence >= latestSequence) updates[`unreadCountBy.${user.uid}`] = 0;
      transaction.update(conversationRef, updates);
    });
    return { ok: true };
  }

  private async presentProfile(id: string, data: ProfileDocument, viewerUid: string) {
    const db = this.firebaseAdmin.db();
    const [followers, following, posts, followedByViewer, account] = await Promise.all([
      db.collection(FOLLOWS).where('followedUid', '==', id).count().get(),
      db.collection(FOLLOWS).where('followerUid', '==', id).count().get(),
      db.collection(POSTS).where('uid', '==', id).count().get(),
      db.collection(FOLLOWS).doc(`${viewerUid}_${id}`).get(),
      this.centralizeLegacyProfile(id, data),
    ]);
    const avatarUrl = this.accountAvatarUrl(account);
    return {
      _id: id,
      username: data.username,
      name: this.accountName(account),
      bio: typeof account.bio === 'string' ? account.bio : '',
      website: typeof account.website === 'string' ? account.website : '',
      location: typeof account.location === 'string' ? account.location : '',
      isOwn: id === viewerUid,
      isFollowing: followedByViewer.exists,
      hasAvatar: Boolean(avatarUrl || data.avatarPath),
      avatarUrl: avatarUrl || undefined,
      avatarVersion: this.timestampMs(account.profilePictureUpdatedAt),
      followersCount: followers.data().count,
      followingCount: following.data().count,
      postsCount: posts.data().count,
    };
  }

  private async centralizeLegacyProfile(id: string, profile: ProfileDocument) {
    const accountRef = this.accountProfileRef(profile.email);
    const account = await this.firebaseAdmin.db().runTransaction(async transaction => {
      const snapshot = await transaction.get(accountRef);
      const current = snapshot.data() || {};
      const migration: Record<string, unknown> = {};
      if (!Object.hasOwn(current, 'fullname') && profile.name) {
        migration.fullname = profile.name;
      }
      for (const field of ['bio', 'website', 'location'] as const) {
        if (!Object.hasOwn(current, field) && typeof profile[field] === 'string') {
          migration[field] = profile[field];
        }
      }
      if (Object.keys(migration).length) {
        transaction.set(
          accountRef,
          { ...migration, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
      }
      return { ...current, ...migration };
    });
    if (profile.name !== undefined || profile.bio !== undefined ||
        profile.website !== undefined || profile.location !== undefined) {
      await this.profileRef(id).update({
        name: FieldValue.delete(),
        bio: FieldValue.delete(),
        website: FieldValue.delete(),
        location: FieldValue.delete(),
      });
    }
    return account;
  }

  private async centralizeLegacyAvatar(id: string, email: string, legacyPath: unknown) {
    let account = await this.accountProfile(email);
    let url = this.accountAvatarUrl(account);
    if (url) {
      if (typeof legacyPath === 'string') await this.removeLegacyAvatar(id, legacyPath);
      return url;
    }
    if (typeof legacyPath !== 'string') return undefined;

    const profileRef = this.profileRef(id);
    const migrationId = randomUUID();
    const claimedPath = await this.firebaseAdmin.db().runTransaction(async transaction => {
      const profile = await transaction.get(profileRef);
      if (!profile.exists || profile.get('avatarPath') !== legacyPath) return undefined;
      const startedAt = profile.get('avatarMigrationStartedAt');
      if (startedAt instanceof Timestamp && Date.now() - startedAt.toMillis() < 60_000) {
        return undefined;
      }
      transaction.update(profileRef, {
        avatarMigrationId: migrationId,
        avatarMigrationStartedAt: Timestamp.now(),
      });
      return legacyPath;
    });
    if (!claimedPath) return undefined;

    try {
      account = await this.accountProfile(email);
      url = this.accountAvatarUrl(account);
      if (!url) {
        const file = this.firebaseAdmin.storageBucket().file(claimedPath);
        const [metadata] = await file.getMetadata();
        const contentType = String(metadata.contentType || 'image/jpeg').toLowerCase();
        const [buffer] = await file.download();
        const result = await this.profilePictureService.uploadProfilePictureBuffer(
          { uid: id, email, roles: [] },
          buffer,
          contentType,
        );
        url = result.url;
      }
      await this.firebaseAdmin.db().runTransaction(async transaction => {
        const profile = await transaction.get(profileRef);
        if (profile.get('avatarMigrationId') !== migrationId) return;
        transaction.update(profileRef, {
          avatarPath: FieldValue.delete(),
          avatarVersion: FieldValue.delete(),
          avatarMigrationId: FieldValue.delete(),
          avatarMigrationStartedAt: FieldValue.delete(),
        });
      });
      await this.firebaseAdmin.storageBucket().file(claimedPath).delete({ ignoreNotFound: true });
      return url;
    } catch (error) {
      await this.firebaseAdmin.db().runTransaction(async transaction => {
        const profile = await transaction.get(profileRef);
        if (profile.get('avatarMigrationId') !== migrationId) return;
        transaction.update(profileRef, {
          avatarMigrationId: FieldValue.delete(),
          avatarMigrationStartedAt: FieldValue.delete(),
        });
      });
      throw error;
    }
  }

  private async removeLegacyAvatar(id: string, path: string) {
    await this.profileRef(id).update({
      avatarPath: FieldValue.delete(),
      avatarVersion: FieldValue.delete(),
    });
    await this.firebaseAdmin.storageBucket().file(path).delete({ ignoreNotFound: true });
  }

  private accountName(account: Record<string, unknown>) {
    const fullname = account.fullname;
    if (typeof fullname === 'string' && fullname.trim()) return fullname.trim();
    const firstName = typeof account.firstName === 'string' ? account.firstName.trim() : '';
    const lastName = typeof account.lastName === 'string' ? account.lastName.trim() : '';
    return `${firstName} ${lastName}`.trim();
  }

  private accountProfileRef(email: string) {
    return this.firebaseAdmin.db().collection('users').doc(email.trim().toLowerCase());
  }

  private async accountProfile(email: string) {
    if (!email) return {};
    const snapshot = await this.accountProfileRef(email).get();
    return snapshot.data() || {};
  }

  private accountAvatarUrl(account: Record<string, unknown>) {
    const url = account.profilePicture || account.avatarUrl || account.profilePictureUrl;
    return typeof url === 'string' && url.trim() ? url.trim() : undefined;
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

  private async presentPosts(docs: FirebaseFirestore.QueryDocumentSnapshot[], viewerUid: string) {
    if (!docs.length) return [];
    const db = this.firebaseAdmin.db();
    const viewerRefs = docs.flatMap(doc => [
      doc.ref.collection('likes').doc(viewerUid),
      db.collection(BOOKMARKS).doc(`${viewerUid}_${doc.id}`),
    ]);
    const authorUids = [...new Set(docs.map(doc => String(doc.get('uid') || '')).filter(Boolean))];
    const [viewerSnapshots, authors, counts] = await Promise.all([
      db.getAll(...viewerRefs),
      Promise.all(authorUids.map(async uid => [
        uid,
        await this.getProfileForUser(uid, viewerUid),
      ] as const)),
      Promise.all(docs.map(async doc => Promise.all([
        doc.ref.collection('likes').count().get(),
        doc.ref.collection('comments').count().get(),
      ]))),
    ]);
    const authorByUid = new Map(authors);
    return docs.map((doc, index) => {
      const data = doc.data() as PostDocument;
      const [likes, comments] = counts[index];
      return {
        _id: doc.id,
        _creationTime: this.timestampMs(data.createdAt),
        caption: data.caption,
        author: authorByUid.get(data.uid) ?? null,
        isOwn: data.uid === viewerUid,
        isLiked: viewerSnapshots[index * 2].exists,
        isBookmarked: viewerSnapshots[index * 2 + 1].exists,
        likesCount: likes.data().count,
        commentsCount: comments.data().count,
        kind: data.kind,
        width: data.width,
        height: data.height,
        duration: data.duration,
      };
    });
  }

  private async requirePost(uid: string, id: string) {
    const snapshot = await this.firebaseAdmin.db().collection(POSTS).doc(id).get();
    if (!snapshot.exists) throw new NotFoundException('Post not found.');
    const authorUid = String(snapshot.get('uid') || '');
    if (await this.isBlockedPair(uid, authorUid)) {
      throw new NotFoundException('Post not found.');
    }
    return snapshot;
  }

  private async requireConversation(uid: string, id: string) {
    const ref = this.firebaseAdmin.db().collection('nookConversations').doc(id);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new NotFoundException('Conversation not found.');
    if (!(snapshot.get('participantUids') as string[] | undefined)?.includes(uid)) {
      throw new ForbiddenException('Not authorized to access this conversation.');
    }
    const otherUid = (snapshot.get('participantUids') as string[]).find(value => value !== uid);
    if (otherUid && await this.isBlockedPair(uid, otherUid)) {
      throw new NotFoundException('Conversation not found.');
    }
    return snapshot;
  }

  private async deleteMediaAndDoc(
    ref: FirebaseFirestore.DocumentReference,
    media: {
      uploadPath?: string;
      cloudinaryPublicId?: string;
      cloudinaryResourceType?: 'image' | 'video' | 'raw';
    },
    post = false,
  ) {
    if (media.cloudinaryPublicId) {
      if (!media.cloudinaryResourceType) throw new BadRequestException('Media provider metadata is invalid.');
      await this.cloudinaryStorage.delete(media.cloudinaryPublicId, media.cloudinaryResourceType);
    } else if (media.uploadPath) {
      await this.firebaseAdmin.storageBucket().file(media.uploadPath).delete({ ignoreNotFound: true });
    }
    if (post) await this.deletePostChildren(ref);
    await ref.delete();
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

  private blockRef(blockerUid: string, blockedUid: string) {
    const id = createHash('sha256')
      .update(JSON.stringify([blockerUid, blockedUid]))
      .digest('hex');
    return this.firebaseAdmin.db().collection(BLOCKS).doc(id);
  }

  private async isBlockedPair(leftUid: string, rightUid: string) {
    if (!leftUid || !rightUid || leftUid === rightUid) return false;
    const [leftBlocksRight, rightBlocksLeft] = await Promise.all([
      this.blockRef(leftUid, rightUid).get(),
      this.blockRef(rightUid, leftUid).get(),
    ]);
    return leftBlocksRight.exists || rightBlocksLeft.exists;
  }

  private async blockedUids(uid: string) {
    const [outgoing, incoming] = await Promise.all([
      this.firebaseAdmin.db().collection(BLOCKS)
        .where('blockerUid', '==', uid).get(),
      this.firebaseAdmin.db().collection(BLOCKS)
        .where('blockedUid', '==', uid).get(),
    ]);
    return new Set([
      ...outgoing.docs.map(row => String(row.get('blockedUid') || '')),
      ...incoming.docs.map(row => String(row.get('blockerUid') || '')),
    ].filter(Boolean));
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

  private decodePostCursor(cursor: string) {
    try {
      if (cursor.length > 3000) throw new Error('Invalid cursor');
      const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('seconds' in parsed) ||
        !('nanoseconds' in parsed) ||
        !('id' in parsed) ||
        typeof parsed.seconds !== 'number' ||
        !Number.isSafeInteger(parsed.seconds) ||
        typeof parsed.nanoseconds !== 'number' ||
        !Number.isInteger(parsed.nanoseconds) ||
        parsed.nanoseconds < 0 ||
        parsed.nanoseconds >= 1_000_000_000 ||
        typeof parsed.id !== 'string' ||
        !parsed.id ||
        parsed.id.length > 1500
      ) {
        throw new Error('Invalid cursor');
      }
      return {
        seconds: parsed.seconds,
        nanoseconds: parsed.nanoseconds,
        id: parsed.id,
      };
    } catch {
      throw new BadRequestException('Invalid post cursor.');
    }
  }

  private decodeProfileCursor(cursor: string) {
    try {
      if (cursor.length > 3000) throw new Error('Invalid cursor');
      const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('username' in parsed) ||
        !('id' in parsed) ||
        typeof parsed.username !== 'string' ||
        !parsed.username ||
        parsed.username.length > 30 ||
        typeof parsed.id !== 'string' ||
        !parsed.id ||
        parsed.id.length > 1500
      ) {
        throw new Error('Invalid cursor');
      }
      return { username: parsed.username, id: parsed.id };
    } catch {
      throw new BadRequestException('Invalid profile cursor.');
    }
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

}
