import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import {
  defaultNotificationPreferences,
  normalizeNotificationPreferences,
  sanitizePreferencePatch,
} from '../notifications/notification-preferences';

type PlainObject = Record<string, unknown>;

type CourseListQuery = {
  category?: string;
  cursor?: string;
  limit?: string;
  query?: string;
  status?: string;
};

type VideoListQuery = {
  category?: string;
  cursor?: string;
  limit?: string;
  query?: string;
  source?: string;
};

type VideoDocument = PlainObject & {
  category?: string;
  description?: string;
  id?: string;
  source?: 'uploaded' | 'youtube';
  thumbnailURL?: string;
  title?: string;
  uploadedBy?: string;
  videoId?: string;
  videoURL?: string;
  visibility?: string;
};

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const AVATAR_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);
const PROFILE_STRING_FIELDS = {
  bio: 500,
  country: 100,
  fullname: 120,
  language: 20,
  profilePicture: 2_048,
} as const;
const PERMISSION_KEYS = [
  'camera',
  'mediaLibrary',
  'location',
  'notifications',
] as const;

@Injectable()
export class AcademyMobileService {
  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

  async getProfile(user: AuthenticatedUser) {
    const { ref, snapshot } = await this.getUserSnapshot(user);

    if (!snapshot.exists) {
      await ref.set(this.newProfileDefaults(user), { merge: true });
      const created = await ref.get();
      return this.serializeProfile(user, created.data() || {});
    }

    return this.serializeProfile(user, snapshot.data() || {});
  }

  async updateProfile(user: AuthenticatedUser, input: unknown) {
    const body = this.requireObject(input);
    const patch: PlainObject = {};

    for (const [field, maxLength] of Object.entries(PROFILE_STRING_FIELDS)) {
      if (field in body) {
        patch[field] = this.optionalString(body[field], field, maxLength);
      }
    }

    if ('trustedDevices' in body) {
      patch.trustedDevices = this.trustedDevices(body.trustedDevices);
    }

    if ('profilePicture' in patch) {
      patch.avatarUrl = patch.profilePicture;
      patch.photoURL = patch.profilePicture;
    }

    if (!Object.keys(patch).length) {
      throw new BadRequestException('At least one profile field is required.');
    }

    await this.userRef(user).set(
      {
        ...patch,
        email: user.email,
        uid: user.uid,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return this.getProfile(user);
  }

  async exportProfile(user: AuthenticatedUser) {
    const [profile, courses] = await Promise.all([
      this.getProfile(user),
      this.listMyCourses(user, { limit: '100' }),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      profile,
      courses: courses.courses,
      courseCount: courses.total,
    };
  }

  async getSettings(user: AuthenticatedUser) {
    const { snapshot } = await this.getUserSnapshot(user);
    const data = snapshot.data() || {};

    return {
      notifications:
        typeof data.notifications === 'boolean'
          ? data.notifications
          : true,
      useBiometrics:
        typeof data.useBiometrics === 'boolean'
          ? data.useBiometrics
          : true,
      emailPreferences: normalizeNotificationPreferences(
        data.emailPreferences,
      ),
    };
  }

  async updateSettings(user: AuthenticatedUser, input: unknown) {
    const body = this.requireObject(input);
    const patch: PlainObject = {};

    if ('notifications' in body) {
      patch.notifications = this.booleanValue(
        body.notifications,
        'notifications',
      );
    }

    if ('useBiometrics' in body) {
      patch.useBiometrics = this.booleanValue(
        body.useBiometrics,
        'useBiometrics',
      );
    }

    if ('emailPreferences' in body) {
      const sanitized = sanitizePreferencePatch(body.emailPreferences);
      if (Object.keys(sanitized).length) {
        const current = await this.getSettings(user);
        patch.emailPreferences = {
          ...current.emailPreferences,
          ...sanitized,
        };
      }
    }

    if (!Object.keys(patch).length) {
      throw new BadRequestException('At least one setting is required.');
    }

    await this.userRef(user).set(
      {
        ...patch,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return this.getSettings(user);
  }

  async updatePermissions(user: AuthenticatedUser, input: unknown) {
    const body = this.requireObject(input);
    const source = this.requireObject(body.permissions);

    const permissions = PERMISSION_KEYS.reduce<Record<string, boolean>>(
      (result, key) => {
        if (typeof source[key] !== 'boolean') {
          throw new BadRequestException(`Invalid ${key} permission value.`);
        }

        result[key] = Boolean(source[key]);
        return result;
      },
      {},
    );

    await this.userRef(user).set(
      {
        permissions,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return { permissions };
  }

  async updatePresence(user: AuthenticatedUser, input: unknown) {
    const body = this.requireObject(input);
    const online = this.booleanValue(body.online, 'online');

    await this.userRef(user).set(
      {
        online,
        ...(online
          ? { lastHeartbeat: FieldValue.serverTimestamp() }
          : { lastSeen: FieldValue.serverTimestamp() }),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return { online };
  }

  async listMyCourses(user: AuthenticatedUser, query: CourseListQuery = {}) {
    const limit = this.parseLimit(query.limit, 50, 100);
    const cursor = this.parseCursor(query.cursor);
    const snapshot = await this.firebaseAdmin
      .db()
      .collection('course')
      .where('createdBy', '==', user.email)
      .orderBy('createdOn', 'desc')
      .offset(cursor)
      .limit(limit + 1)
      .get();

    const courses = snapshot.docs
      .slice(0, limit)
      .map(doc => this.toCourse(doc.id, doc.data()))
      .filter(course => {
        if (query.status !== 'completed') return true;

        return (
          Array.isArray(course.completedChapter) &&
          course.completedChapter.length > 0
        );
      });

    return {
      courses,
      nextCursor:
        snapshot.docs.length > limit ? String(cursor + limit) : null,
      total: courses.length,
    };
  }

  async listCourses(query: CourseListQuery = {}) {
    const limit = this.parseLimit(query.limit, 50, 100);
    const cursor = this.parseCursor(query.cursor);
    const courses = this.filterCourses(await this.loadCourses(), query);
    const items = courses.slice(cursor, cursor + limit);

    return {
      courses: items,
      nextCursor:
        cursor + limit < courses.length ? String(cursor + limit) : null,
      total: courses.length,
    };
  }

  async getCourseById(courseId: string) {
    if (!courseId) {
      throw new BadRequestException('Course id required.');
    }

    const snapshot = await this.firebaseAdmin
      .db()
      .collection('course')
      .doc(courseId)
      .get();

    if (!snapshot.exists) {
      throw new NotFoundException('Course not found.');
    }

    const course = this.toCourse(snapshot.id, snapshot.data() || {});
    if (!this.isCanonicalCourse(course)) {
      throw new NotFoundException('Course not found.');
    }

    return course;
  }

  async listVideos(query: VideoListQuery = {}) {
    const limit = this.parseLimit(query.limit, 50, 100);
    const cursor = this.parseCursor(query.cursor);
    const allVideos = await this.loadVideos();
    const filtered = this.filterVideos(allVideos, query);
    const items = filtered.slice(cursor, cursor + limit);

    return {
      videos: items,
      nextCursor:
        cursor + limit < filtered.length ? String(cursor + limit) : null,
      total: filtered.length,
    };
  }

  async getVideoById(videoId: string) {
    if (!videoId) {
      throw new BadRequestException('Video id required.');
    }

    const db = this.firebaseAdmin.db();
    const [uploadedSnap, youtubeSnap] = await Promise.all([
      db.collection('videos').doc(videoId).get(),
      db.collection('youTubeVideos').doc(videoId).get(),
    ]);

    if (uploadedSnap.exists) {
      const video = this.toUploadedVideo(
        uploadedSnap.id,
        uploadedSnap.data() || {},
      );
      if (video.visibility === 'public') return video;
    }

    if (youtubeSnap.exists) {
      return this.toYouTubeVideo(youtubeSnap.id, youtubeSnap.data() || {});
    }

    const youtubeByVideoId = await db
      .collection('youTubeVideos')
      .where('videoId', '==', videoId)
      .limit(1)
      .get();

    if (!youtubeByVideoId.empty) {
      const doc = youtubeByVideoId.docs[0];
      return this.toYouTubeVideo(doc.id, doc.data());
    }

    throw new NotFoundException('Video not found.');
  }

  async lookupYouTubeVideo(query: { url?: string; videoId?: string }) {
    const videoId = this.youtubeVideoId(query.videoId || query.url);
    if (!videoId) {
      throw new BadRequestException('Valid YouTube URL or videoId required.');
    }

    const oembedUrl = new URL('https://www.youtube.com/oembed');
    oembedUrl.searchParams.set(
      'url',
      `https://www.youtube.com/watch?v=${videoId}`,
    );
    oembedUrl.searchParams.set('format', 'json');

    const response = await fetch(oembedUrl);
    if (!response.ok) {
      throw new ServiceUnavailableException('Unable to load YouTube video info.');
    }

    const data = (await response.json()) as {
      thumbnail_url?: string;
      title?: string;
    };

    return {
      videoId,
      title: this.stringValue(data.title, 'Untitled YouTube video'),
      thumbnailURL:
        this.stringValue(data.thumbnail_url) ||
        `https://img.youtube.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`,
    };
  }

  async deleteVideo(user: AuthenticatedUser, videoId: string) {
    if (!videoId) {
      throw new BadRequestException('Video id required.');
    }

    const db = this.firebaseAdmin.db();
    const [uploadedSnap, youtubeSnap] = await Promise.all([
      db.collection('videos').doc(videoId).get(),
      db.collection('youTubeVideos').doc(videoId).get(),
    ]);

    if (youtubeSnap.exists) {
      const video = this.toYouTubeVideo(youtubeSnap.id, youtubeSnap.data() || {});
      this.assertCanMutateVideo(user, video);
      await youtubeSnap.ref.delete();
      return { deleted: true, source: 'youtube' };
    }

    if (uploadedSnap.exists) {
      const video = this.toUploadedVideo(
        uploadedSnap.id,
        uploadedSnap.data() || {},
      );
      this.assertCanMutateVideo(user, video);

      await Promise.all([
        this.deleteStorageUrl(video.videoURL),
        this.deleteStorageUrl(video.thumbnailURL),
      ]);
      await uploadedSnap.ref.delete();

      return { deleted: true, source: 'uploaded' };
    }

    throw new NotFoundException('Video not found.');
  }

  async saveFcmToken(user: AuthenticatedUser, input: unknown) {
    const body = this.requireObject(input);
    const token = this.requiredString(body.fcmToken, 'fcmToken', 4_096);
    const platform =
      'platform' in body
        ? this.optionalString(body.platform, 'platform', 40)
        : 'unknown';
    const tokenHash = this.sha256(token);
    const userRef = this.userRef(user);

    await Promise.all([
      userRef.set(
        {
          fcmToken: token,
          fcmTokens: FieldValue.arrayUnion(token),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      ),
      userRef.collection('notificationTokens').doc(tokenHash).set(
        {
          token,
          platform,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      ),
    ]);

    return { saved: true };
  }

  async sendNotification(user: AuthenticatedUser, input: unknown) {
    const body = this.requireObject(input);
    const targetEmail = this.requiredString(body.userEmail, 'userEmail', 254)
      .trim()
      .toLowerCase();
    const title = this.requiredString(body.title, 'title', 120);
    const message = this.requiredString(body.body, 'body', 1_000);
    const userSnapshot = await this.firebaseAdmin
      .db()
      .collection('users')
      .doc(targetEmail)
      .get();

    if (!userSnapshot.exists) {
      throw new NotFoundException('Notification target user not found.');
    }

    const data = userSnapshot.data() || {};
    const tokens = this.fcmTokens(data);

    await this.firebaseAdmin
      .db()
      .collection('notifications')
      .add({
        body: message,
        createdAt: FieldValue.serverTimestamp(),
        from: user.uid,
        fromEmail: user.email,
        read: false,
        title,
        to: data.uid || targetEmail,
        toEmail: targetEmail,
      });

    if (!tokens.length) {
      return { sent: false, saved: true, reason: 'No FCM token registered.' };
    }

    const response = await this.firebaseAdmin.messaging().sendEachForMulticast({
      data: {
        from: user.uid,
        type: 'academy',
      },
      notification: {
        body: message,
        title,
      },
      tokens,
    });

    return {
      sent: response.successCount > 0,
      successCount: response.successCount,
      failureCount: response.failureCount,
    };
  }

  async uploadAvatar(user: AuthenticatedUser, input: unknown) {
    const body = this.requireObject(input);
    const parsed = this.parseImageBody(body);
    const buffer = Buffer.from(parsed.base64, 'base64');

    if (!buffer.length) {
      throw new BadRequestException('Avatar image is empty.');
    }

    if (buffer.length > MAX_AVATAR_BYTES) {
      throw new BadRequestException('Avatar image must be 5 MB or smaller.');
    }

    const extension = this.avatarExtension(parsed.contentType);
    const objectPath = `avatars/${user.uid}.${extension}`;
    const token = randomUUID();
    const bucket = this.firebaseAdmin.storageBucket();
    const file = bucket.file(objectPath);

    await file.save(buffer, {
      metadata: {
        contentType: parsed.contentType,
        metadata: {
          firebaseStorageDownloadTokens: token,
        },
      },
      resumable: false,
    });

    const downloadUrl = this.firebaseStorageDownloadUrl(
      bucket.name,
      objectPath,
      token,
    );

    await this.userRef(user).set(
      {
        avatarUrl: downloadUrl,
        photoURL: downloadUrl,
        profilePicture: downloadUrl,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      profilePicture: downloadUrl,
      avatarUrl: downloadUrl,
      photoURL: downloadUrl,
    };
  }

  private async getUserSnapshot(user: AuthenticatedUser) {
    const ref = this.userRef(user);
    const snapshot = await ref.get();

    return { ref, snapshot };
  }

  private userRef(user: AuthenticatedUser) {
    if (!user.email) {
      throw new BadRequestException('Authenticated user email is required.');
    }

    return this.firebaseAdmin.db().collection('users').doc(user.email);
  }

  private newProfileDefaults(user: AuthenticatedUser) {
    return {
      bio: '',
      country: '',
      createdAt: FieldValue.serverTimestamp(),
      email: user.email,
      emailPreferences: defaultNotificationPreferences,
      fullname: user.email.split('@')[0],
      id: user.uid,
      isVerified: true,
      language: 'en',
      lastLogin: FieldValue.serverTimestamp(),
      provider: 'chefu-sso',
      roles: user.roles,
      subscriptionStatus: 'free',
      uid: user.uid,
      updatedAt: FieldValue.serverTimestamp(),
    };
  }

  private serializeProfile(user: AuthenticatedUser, data: PlainObject) {
    const profile = this.toPlainObject(data);
    const roles = Array.isArray(profile.roles)
      ? profile.roles.map(role => String(role))
      : user.roles;

    return {
      bio: '',
      country: '',
      emailPreferences: defaultNotificationPreferences,
      fullname: user.email.split('@')[0],
      language: 'en',
      profilePicture: '',
      ...profile,
      avatarUrl: profile.avatarUrl || profile.profilePicture || '',
      email: user.email,
      id: profile.id || user.uid,
      photoURL: profile.photoURL || profile.profilePicture || '',
      roles,
      uid: profile.uid || user.uid,
    };
  }

  private async loadVideos() {
    const db = this.firebaseAdmin.db();
    const [uploadedSnap, youtubeSnap] = await Promise.all([
      db.collection('videos').get(),
      db.collection('youTubeVideos').get(),
    ]);

    return [
      ...uploadedSnap.docs
        .map(doc => this.toUploadedVideo(doc.id, doc.data()))
        .filter(video => video.visibility === 'public'),
      ...youtubeSnap.docs.map(doc => this.toYouTubeVideo(doc.id, doc.data())),
    ].sort(
      (a, b) =>
        this.timestampMillis(b.uploadedAt || b.createdAt) -
        this.timestampMillis(a.uploadedAt || a.createdAt),
    );
  }

  private async loadCourses() {
    const snapshot = await this.firebaseAdmin.db().collection('course').get();

    return snapshot.docs
      .map(doc => this.toCourse(doc.id, doc.data()))
      .filter(course => this.isCanonicalCourse(course))
      .sort(
        (a, b) =>
          this.timestampMillis(b.createdOn) -
          this.timestampMillis(a.createdOn),
      );
  }

  private filterCourses(courses: PlainObject[], query: CourseListQuery) {
    const category = String(query.category || '').trim().toLowerCase();
    const search = String(query.query || '').trim().toLowerCase();

    return courses.filter(course => {
      if (
        category &&
        String(course.category || '').trim().toLowerCase() !== category
      ) {
        return false;
      }

      if (!search) return true;

      return [
        course.courseTitle,
        course.title,
        course.category,
        course.description,
      ]
        .map(value => String(value || '').toLowerCase())
        .join(' ')
        .includes(search);
    });
  }

  private isCanonicalCourse(course: PlainObject) {
    return !course.enrolled && !course.originalCourseId;
  }

  private filterVideos(videos: VideoDocument[], query: VideoListQuery) {
    const category = String(query.category || '').trim().toLowerCase();
    const source = String(query.source || '').trim().toLowerCase();
    const search = String(query.query || '').trim().toLowerCase();

    return videos.filter(video => {
      if (source && video.source !== source) return false;
      if (
        category &&
        String(video.category || '').trim().toLowerCase() !== category
      ) {
        return false;
      }

      if (!search) return true;

      return [
        video.title,
        video.category,
        video.description,
        ...(Array.isArray(video.topics) ? video.topics : []),
      ]
        .map(value => String(value || '').toLowerCase())
        .join(' ')
        .includes(search);
    });
  }

  private youtubeVideoId(value: unknown) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return '';

    const direct = text.match(/^[a-zA-Z0-9_-]{11}$/);
    if (direct) return text;

    const patterns = [
      /youtu\.be\/([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/watch\?[^#]*v=([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) return match[1];
    }

    return '';
  }

  private toCourse(
    id: string,
    data: FirebaseFirestore.DocumentData,
  ): PlainObject {
    const course = this.toPlainObject(data);

    return {
      ...course,
      id,
      docId: course.docId || id,
      courseTitle: course.courseTitle || course.title || 'Untitled course',
      chapters: Array.isArray(course.chapters) ? course.chapters : [],
      completedChapter: Array.isArray(course.completedChapter)
        ? course.completedChapter
        : [],
      flashcards: Array.isArray(course.flashcards) ? course.flashcards : [],
      qa: Array.isArray(course.qa) ? course.qa : [],
      quiz: Array.isArray(course.quiz) ? course.quiz : [],
    };
  }

  private toUploadedVideo(id: string, data: FirebaseFirestore.DocumentData) {
    const video = this.toPlainObject(data);

    return {
      ...video,
      id,
      source: 'uploaded',
      title: this.stringValue(video.title, 'Untitled video'),
      description: this.stringValue(video.description),
      videoURL: this.stringValue(video.videoURL || video.url),
      thumbnailURL: this.stringValue(video.thumbnailURL || video.thumbnail),
      uploadedBy: this.stringValue(video.uploadedBy),
      category: this.stringValue(video.category, 'Tech & Coding'),
      visibility: this.stringValue(video.visibility, 'public'),
      duration: Number(video.duration || 0),
      views: Number(video.views || 0),
    } as VideoDocument;
  }

  private toYouTubeVideo(id: string, data: FirebaseFirestore.DocumentData) {
    const video = this.toPlainObject(data);
    const youtubeVideoId = String(video.videoId || '').trim();

    return {
      ...video,
      id,
      source: 'youtube',
      videoId: youtubeVideoId,
      youtubeVideoId,
      title: this.stringValue(video.title, 'Untitled YouTube video'),
      description: this.stringValue(video.description),
      thumbnailURL: this.stringValue(video.thumbnailURL || video.thumbnail),
      uploadedBy: this.stringValue(
        video.uploadedBy || video.channelTitle,
        'YouTube',
      ),
      category: this.stringValue(video.category, 'YouTube'),
      videoURL: youtubeVideoId
        ? `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeVideoId)}`
        : '',
      embedURL: youtubeVideoId
        ? `https://www.youtube.com/embed/${encodeURIComponent(youtubeVideoId)}`
        : '',
    } as VideoDocument;
  }

  private assertCanMutateVideo(user: AuthenticatedUser, video: VideoDocument) {
    if (user.roles.includes('admin')) return;

    const owner = String(
      video.uploadedBy || video.createdBy || video.ownerEmail || '',
    )
      .trim()
      .toLowerCase();
    const email = user.email.trim().toLowerCase();

    if (owner && owner === email) return;

    throw new ForbiddenException('You are not authorized to modify this video.');
  }

  private async deleteStorageUrl(value: unknown) {
    const objectPath = this.storagePathFromUrl(value);
    if (!objectPath) return;

    try {
      await this.firebaseAdmin.storageBucket().file(objectPath).delete();
    } catch (error) {
      if (!this.isNotFoundError(error)) {
        throw error;
      }
    }
  }

  private storagePathFromUrl(value: unknown) {
    const url = typeof value === 'string' ? value : '';
    if (!url) return null;

    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'firebasestorage.googleapis.com') {
        const match = parsed.pathname.match(/\/o\/([^/]+)/);
        return match ? decodeURIComponent(match[1]) : null;
      }

      if (parsed.hostname === 'storage.googleapis.com') {
        const parts = parsed.pathname.split('/').filter(Boolean);
        return parts.length > 1
          ? decodeURIComponent(parts.slice(1).join('/'))
          : null;
      }
    } catch {
      return null;
    }

    return null;
  }

  private parseImageBody(body: PlainObject) {
    const raw = this.requiredString(body.imageBase64, 'imageBase64', 8_000_000);
    const dataUriMatch = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    const contentType = String(
      dataUriMatch?.[1] || body.contentType || 'image/jpeg',
    ).toLowerCase();
    const base64 = dataUriMatch ? dataUriMatch[2] : raw;

    if (!AVATAR_CONTENT_TYPES.has(contentType)) {
      throw new BadRequestException('Unsupported avatar image type.');
    }

    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) {
      throw new BadRequestException('Avatar image must be base64 encoded.');
    }

    return {
      base64,
      contentType: contentType === 'image/jpg' ? 'image/jpeg' : contentType,
    };
  }

  private avatarExtension(contentType: string) {
    if (contentType === 'image/png') return 'png';
    if (contentType === 'image/webp') return 'webp';

    return 'jpg';
  }

  private firebaseStorageDownloadUrl(
    bucketName: string,
    objectPath: string,
    token: string,
  ) {
    return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectPath)}?alt=media&token=${encodeURIComponent(token)}`;
  }

  private requireObject(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('Request body must be an object.');
    }

    return value as PlainObject;
  }

  private requiredString(value: unknown, field: string, maxLength: number) {
    const text = this.optionalString(value, field, maxLength);
    if (!text) {
      throw new BadRequestException(`${field} is required.`);
    }

    return text;
  }

  private optionalString(value: unknown, field: string, maxLength: number) {
    if (typeof value !== 'string') {
      throw new BadRequestException(`${field} must be a string.`);
    }

    const text = value.trim();
    if (text.length > maxLength) {
      throw new BadRequestException(`${field} is too long.`);
    }

    return text;
  }

  private booleanValue(value: unknown, field: string) {
    if (typeof value !== 'boolean') {
      throw new BadRequestException(`${field} must be a boolean.`);
    }

    return value;
  }

  private trustedDevices(value: unknown) {
    if (!Array.isArray(value)) {
      throw new BadRequestException('trustedDevices must be an array.');
    }

    if (value.length > 25) {
      throw new BadRequestException('trustedDevices has too many entries.');
    }

    return value.map(item => {
      const device = this.requireObject(item);

      return {
        brand: this.optionalDeviceString(device.brand, 'brand'),
        deviceType: this.optionalDeviceString(device.deviceType, 'deviceType'),
        modelName: this.optionalDeviceString(device.modelName, 'modelName'),
        osName: this.optionalDeviceString(device.osName, 'osName'),
        osVersion: this.optionalDeviceString(device.osVersion, 'osVersion'),
        trustedAt: this.optionalDeviceString(device.trustedAt, 'trustedAt'),
      };
    });
  }

  private optionalDeviceString(value: unknown, field: string) {
    if (value === undefined || value === null) return '';

    return this.optionalString(value, field, 120);
  }

  private fcmTokens(data: PlainObject) {
    const tokens = new Set<string>();
    const singleToken = this.stringValue(data.fcmToken);
    if (singleToken) tokens.add(singleToken);

    if (Array.isArray(data.fcmTokens)) {
      data.fcmTokens
        .map(token => this.stringValue(token))
        .filter((token): token is string => Boolean(token))
        .forEach(token => tokens.add(token));
    }

    return [...tokens];
  }

  private parseLimit(value: string | undefined, fallback: number, max: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;

    return Math.min(Math.floor(parsed), max);
  }

  private parseCursor(value: string | undefined) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;

    return Math.floor(parsed);
  }

  private stringValue(value: unknown, fallback = '') {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || fallback;
  }

  private timestampMillis(value: unknown): number {
    if (!value) return 0;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string') return Date.parse(value) || 0;
    if (
      typeof value === 'object' &&
      'toMillis' in value &&
      typeof value.toMillis === 'function'
    ) {
      return value.toMillis();
    }
    if (
      typeof value === 'object' &&
      '_seconds' in value &&
      typeof value._seconds === 'number'
    ) {
      return value._seconds * 1000;
    }

    return 0;
  }

  private toPlainObject(data: FirebaseFirestore.DocumentData) {
    return this.toPlainValue(data) as PlainObject;
  }

  private toPlainValue(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(item => this.toPlainValue(item));
    if (!value || typeof value !== 'object') return value;

    if ('toDate' in value && typeof value.toDate === 'function') {
      return value.toDate().toISOString();
    }

    return Object.fromEntries(
      Object.entries(value as PlainObject).map(([key, item]) => [
        key,
        this.toPlainValue(item),
      ]),
    );
  }

  private sha256(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private isNotFoundError(error: unknown) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      String((error as { code?: unknown }).code) === '404'
    );
  }
}
