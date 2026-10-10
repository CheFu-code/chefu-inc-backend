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
  id: string;
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
  countryCode: 16,
  defaultCourseDifficulty: 40,
  fullname: 120,
  language: 20,
  learningGoal: 500,
  lessonStyle: 40,
  preferredContentFormat: 40,
  profilePicture: 2_048,
  skillLevel: 40,
} as const;
const PROFILE_ENUM_FIELDS: Record<string, readonly string[]> = {
  defaultCourseDifficulty: ['beginner', 'intermediate', 'advanced'],
  lessonStyle: ['short', 'detailed', 'example-heavy'],
  preferredContentFormat: ['text', 'examples', 'quizzes'],
  skillLevel: ['beginner', 'intermediate', 'advanced'],
};
const PERMISSION_KEYS = [
  'camera',
  'mediaLibrary',
  'location',
  'notifications',
] as const;
const CATALOG_CACHE_TTL_MS = 15_000;

@Injectable()
export class AcademyMobileService {
  private coursesCache?: { courses: PlainObject[]; expiresAt: number };
  private coursesRequest?: Promise<PlainObject[]>;
  private videosCache?: { videos: VideoDocument[]; expiresAt: number };
  private videosRequest?: Promise<VideoDocument[]>;

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
        const value = this.optionalString(body[field], field, maxLength);
        const allowedValues = PROFILE_ENUM_FIELDS[field];
        if (allowedValues && value && !allowedValues.includes(value)) {
          throw new BadRequestException(`${field} has an unsupported value.`);
        }
        patch[field] = value;
      }
    }

    for (const field of ['onboardingComplete', 'appGuideComplete', 'aiTutorSuggestions']) {
      if (field in body) {
        patch[field] = this.booleanValue(body[field], field);
      }
    }

    if ('weeklyLearningGoal' in body) {
      const goal = body.weeklyLearningGoal;
      if (typeof goal !== 'number' || !Number.isInteger(goal) || goal < 0 || goal > 168) {
        throw new BadRequestException('weeklyLearningGoal must be an integer from 0 to 168.');
      }
      patch.weeklyLearningGoal = goal;
    }

    if ('learningInterests' in body) {
      if (
        !Array.isArray(body.learningInterests) ||
        body.learningInterests.length > 50 ||
        body.learningInterests.some(
          interest => typeof interest !== 'string' || interest.trim().length > 80,
        )
      ) {
        throw new BadRequestException('learningInterests must be a list of at most 50 short strings.');
      }
      patch.learningInterests = [
        ...new Set(body.learningInterests.map(interest => (interest as string).trim()).filter(Boolean)),
      ];
    }

    if ('favoriteCourseIds' in body) {
      if (
        !Array.isArray(body.favoriteCourseIds) ||
        body.favoriteCourseIds.length > 500 ||
        body.favoriteCourseIds.some(
          id => typeof id !== 'string' || !id.trim() || id.trim().length > 200,
        )
      ) {
        throw new BadRequestException('favoriteCourseIds must be a list of at most 500 course ids.');
      }
      patch.favoriteCourseIds = [
        ...new Set(body.favoriteCourseIds.map(id => (id as string).trim())),
      ];
      patch.favoriteCoursesUpdatedAt = FieldValue.serverTimestamp();
    }

    if ('privacy' in body) {
      const privacy = this.requireObject(body.privacy);
      const allowedPrivacyKeys = [
        'publicProfile',
        'showCompletedCourses',
        'showCountry',
        'personalizedAiRecommendations',
      ];
      const normalized: PlainObject = {};
      for (const [field, value] of Object.entries(privacy)) {
        if (!allowedPrivacyKeys.includes(field)) {
          throw new BadRequestException(`Unsupported privacy preference: ${field}.`);
        }
        normalized[field] = this.booleanValue(value, `privacy.${field}`);
      }
      patch.privacy = normalized;
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

  async createCourse(user: AuthenticatedUser, input: unknown) {
    const body = this.requireObject(input);
    const courseTitle = this.requiredString(body.courseTitle, 'courseTitle', 160);
    const description = this.optionalString(body.description ?? '', 'description', 20_000);
    const category = this.requiredString(body.category, 'category', 120);
    const chapters = this.requireArray(body.chapters, 'chapters', 200);
    const flashcards = this.requireArray(body.flashcards ?? [], 'flashcards', 2_000);
    const qa = this.requireArray(body.qa ?? [], 'qa', 2_000);
    const quiz = this.requireArray(body.quiz ?? [], 'quiz', 2_000);
    const bannerImage = this.optionalString(body.banner_image ?? '', 'banner_image', 2_048);
    const courseRef = this.firebaseAdmin.db().collection('course').doc();
    const course = {
      banner_image: bannerImage,
      category,
      chapters,
      courseTitle,
      createdBy: user.email,
      createdOn: FieldValue.serverTimestamp(),
      description,
      docId: courseRef.id,
      enrolled: false,
      completedChapter: [],
      flashcards,
      qa,
      quiz,
    };
    if (Buffer.byteLength(JSON.stringify(course), 'utf8') > 900_000) {
      throw new BadRequestException('Course content is too large to save.');
    }

    await courseRef.create(course);
    return { course: { ...course, id: courseRef.id } };
  }

  async enrollCourse(user: AuthenticatedUser, courseId: string) {
    if (!courseId) throw new BadRequestException('Course id required.');
    const db = this.firebaseAdmin.db();
    const rootRef = db.collection('course').doc(courseId);
    const rootSnapshot = await rootRef.get();
    if (!rootSnapshot.exists) throw new NotFoundException('Course not found.');

    const rootCourse = this.toCourse(rootSnapshot.id, rootSnapshot.data() || {});
    if (!this.isCanonicalCourse(rootCourse)) {
      throw new BadRequestException('This course copy cannot be enrolled directly.');
    }
    if (String(rootCourse.createdBy || '').toLowerCase() === user.email.toLowerCase()) {
      throw new ForbiddenException("You can't enroll in your own course.");
    }

    const existing = await db
      .collection('course')
      .where('createdBy', '==', user.email)
      .where('originalCourseId', '==', courseId)
      .limit(1)
      .get();
    if (!existing.empty) {
      const enrolledCourse = this.toCourse(existing.docs[0].id, existing.docs[0].data());
      return { course: enrolledCourse, alreadyEnrolled: true };
    }

    const enrollmentId = `enrolled_${this.sha256(`${user.uid}:${courseId}`).slice(0, 48)}`;
    const enrollmentRef = db.collection('course').doc(enrollmentId);
    const enrolledCourse = {
      ...rootCourse,
      createdBy: user.email,
      createdOn: FieldValue.serverTimestamp(),
      docId: enrollmentId,
      enrolled: true,
      originalCourseId: courseId,
      completedChapter: [],
      lastStudiedAt: null,
      lastStudiedChapterIndex: null,
      lastStudiedContentIndex: null,
      lastStudiedChapterName: '',
      lastStudiedTopic: '',
    };

    await db.runTransaction(async transaction => {
      const existingEnrollment = await transaction.get(enrollmentRef);
      if (!existingEnrollment.exists) transaction.create(enrollmentRef, enrolledCourse);
    });
    const saved = await enrollmentRef.get();
    return {
      course: this.toCourse(saved.id, saved.data() || {}),
      alreadyEnrolled: false,
    };
  }

  async getCourseById(courseId: string, user: AuthenticatedUser) {
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
    if (
      !this.isCanonicalCourse(course) &&
      String(course.createdBy || '').toLowerCase() !== user.email.toLowerCase()
    ) {
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

  async enrollVideo(user: AuthenticatedUser, videoId: string) {
    const video = await this.getVideoById(videoId);
    const userRef = this.userRef(user);
    const enrollmentRef = userRef.collection('enrollments').doc(video.id);
    const videoCollection =
      video.source === 'youtube' ? 'youTubeVideos' : 'videos';
    const videoRef = this.firebaseAdmin
      .db()
      .collection(videoCollection)
      .doc(video.id);
    let alreadyEnrolled = false;

    await this.firebaseAdmin.db().runTransaction(async transaction => {
      const enrollment = await transaction.get(enrollmentRef);
      const videoSnapshot = await transaction.get(videoRef);

      if (!videoSnapshot.exists) {
        throw new NotFoundException('Video not found.');
      }
      if (enrollment.exists) {
        alreadyEnrolled = true;
        return;
      }

      transaction.create(enrollmentRef, {
        videoId: video.id,
        title: video.title,
        thumbnailURL: video.thumbnailURL || '',
        enrolledAt: FieldValue.serverTimestamp(),
      });
      transaction.update(videoRef, { views: FieldValue.increment(1) });
    });

    const updatedVideo = await this.getVideoById(videoId);
    return {
      enrolled: true,
      alreadyEnrolled,
      views: Number(updatedVideo.views || 0),
    };
  }

  async getVideoEnrollment(user: AuthenticatedUser, videoId: string) {
    const video = await this.getVideoById(videoId);
    const enrollment = await this.userRef(user)
      .collection('enrollments')
      .doc(video.id)
      .get();
    return { enrolled: enrollment.exists };
  }

  async listReviews(collection: 'videos', entityId: string) {
    if (!entityId) throw new BadRequestException('Video id required.');
    const snapshot = await this.firebaseAdmin
      .db()
      .collection(collection)
      .doc(entityId)
      .collection('reviews')
      .orderBy('createdAt', 'desc')
      .limit(200)
      .get();
    return {
      reviews: snapshot.docs.map(doc => ({
        id: doc.id,
        ...this.toPlainObject(doc.data()),
      })),
    };
  }

  async createReview(
    user: AuthenticatedUser,
    collection: 'videos',
    entityId: string,
    input: unknown,
  ) {
    const body = this.requireObject(input);
    const rating = this.reviewRating(body.rating);
    const comment = this.optionalString(body.comment, 'comment', 2_000).trim();
    const video = await this.getVideoById(entityId);
    const userData = (await this.userRef(user).get()).data() || {};
    const reviewRef = this.firebaseAdmin
      .db()
      .collection(collection)
      .doc(video.id)
      .collection('reviews')
      .doc(user.uid);
    await this.firebaseAdmin.db().runTransaction(async transaction => {
      const existing = await transaction.get(reviewRef);
      if (existing.exists) {
        throw new BadRequestException('You have already reviewed this video.');
      }
      transaction.create(reviewRef, {
        userId: user.uid,
        username: this.stringValue(userData.fullname, user.email),
        email: user.email,
        avatar: this.stringValue(userData.profilePicture),
        rating,
        comment,
        videoId: video.id,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    return { review: { id: reviewRef.id, rating, comment, userId: user.uid } };
  }

  async updateReview(
    user: AuthenticatedUser,
    collection: 'videos',
    entityId: string,
    reviewId: string,
    input: unknown,
  ) {
    const body = this.requireObject(input);
    const rating = this.reviewRating(body.rating);
    const comment = this.optionalString(body.comment, 'comment', 2_000).trim();
    const reviewRef = this.firebaseAdmin
      .db()
      .collection(collection)
      .doc(entityId)
      .collection('reviews')
      .doc(reviewId);
    const snapshot = await reviewRef.get();
    if (!snapshot.exists) throw new NotFoundException('Review not found.');
    if (snapshot.data()?.userId !== user.uid) {
      throw new ForbiddenException('You can only edit your own review.');
    }
    await reviewRef.update({
      rating,
      comment,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { updated: true };
  }

  async deleteReview(
    user: AuthenticatedUser,
    collection: 'videos',
    entityId: string,
    reviewId: string,
  ) {
    const reviewRef = this.firebaseAdmin
      .db()
      .collection(collection)
      .doc(entityId)
      .collection('reviews')
      .doc(reviewId);
    const snapshot = await reviewRef.get();
    if (!snapshot.exists) throw new NotFoundException('Review not found.');
    if (snapshot.data()?.userId !== user.uid) {
      throw new ForbiddenException('You can only delete your own review.');
    }
    await reviewRef.delete();
    return { deleted: true };
  }

  async getCourseReview(
    user: AuthenticatedUser,
    courseId: string,
    reviewId: string,
  ) {
    if (reviewId !== user.uid) {
      throw new ForbiddenException('You can only read your own review.');
    }
    const snapshot = await this.firebaseAdmin
      .db()
      .collection('course')
      .doc(courseId)
      .collection('reviews')
      .doc(reviewId)
      .get();
    return {
      review: snapshot.exists
        ? this.toPlainObject(snapshot.data() || {})
        : null,
    };
  }

  async saveCourseReview(
    user: AuthenticatedUser,
    courseId: string,
    input: unknown,
  ) {
    const body = this.requireObject(input);
    const rating = this.reviewRating(body.rating);
    const comment = this.optionalString(body.comment, 'comment', 2_000).trim();
    const db = this.firebaseAdmin.db();
    const courseRef = db.collection('course').doc(courseId);
    const enrollmentQuery = await db
      .collection('course')
      .where('createdBy', '==', user.email)
      .where('originalCourseId', '==', courseId)
      .limit(1)
      .get();
    const candidateRef = enrollmentQuery.empty
      ? courseRef
      : enrollmentQuery.docs[0].ref;
    const [courseSnapshot, enrollmentSnapshot] = await Promise.all([
      candidateRef.get(),
      db.collection('course').where('createdBy', '==', user.email).limit(100).get(),
    ]);
    if (!courseSnapshot.exists) throw new NotFoundException('Course not found.');
    const course = courseSnapshot.data() || {};
    const completeCourse =
      enrollmentSnapshot.docs.find(doc => doc.id === candidateRef.id)?.data() ||
      course;
    const chapters = Array.isArray(completeCourse.chapters)
      ? completeCourse.chapters
      : [];
    const completed = Array.isArray(completeCourse.completedChapter)
      ? completeCourse.completedChapter
      : [];
    if (
      String(completeCourse.createdBy || '').toLowerCase() !==
        user.email.toLowerCase() ||
      chapters.length === 0 ||
      completed.length < chapters.length
    ) {
      throw new ForbiddenException('Complete the course before reviewing it.');
    }

    const reviewRef = courseRef.collection('reviews').doc(user.uid);
    const userData = (await this.userRef(user).get()).data() || {};
    const stats = await db.runTransaction(async transaction => {
      const [freshCourse, previousReview] = await Promise.all([
        transaction.get(courseRef),
        transaction.get(reviewRef),
      ]);
      if (!freshCourse.exists) throw new NotFoundException('Course not found.');
      const data = freshCourse.data() || {};
      const oldAverage = Number(data.averageRating) || 0;
      const oldCount = Number(data.reviewCount) || 0;
      const previousRating = Number(previousReview.data()?.rating) || 0;
      const count = previousReview.exists ? oldCount : oldCount + 1;
      const average = Number(
        ((oldAverage * oldCount - previousRating + rating) / count).toFixed(2),
      );
      transaction.set(
        reviewRef,
        {
          rating,
          comment,
          courseId,
          courseTitle: this.stringValue(course.courseTitle),
          userEmail: user.email,
          username: this.stringValue(userData.fullname, user.email),
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: previousReview.data()?.createdAt || FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      transaction.set(
        courseRef,
        { averageRating: average, reviewCount: count },
        { merge: true },
      );
      return { averageRating: average, reviewCount: count };
    });
    return { review: { rating, comment }, stats };
  }

  async createFeedback(user: AuthenticatedUser, input: unknown) {
    const body = this.requireObject(input);
    const providedName = this.requiredString(body.name, 'name', 120);
    const providedEmail = this.requiredString(body.email, 'email', 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(providedEmail)) {
      throw new BadRequestException('A valid email address is required.');
    }
    const message = this.requiredString(body.message, 'message', 10_000);
    const userData = (await this.userRef(user).get()).data() || {};
    const ref = await this.firebaseAdmin.db().collection('feedback').add({
      providedName,
      realName: this.stringValue(userData.fullname) || null,
      providedEmail,
      realEmail: user.email || null,
      message,
      createdAt: FieldValue.serverTimestamp(),
      userId: user.uid,
      planType: this.stringValue(userData.subscriptionStatus, 'Free'),
      device: this.optionalString(body.device, 'device', 1_000),
      pageURL: this.optionalString(body.pageURL, 'pageURL', 2_048),
      referrer: this.optionalString(body.referrer, 'referrer', 2_048) || null,
      status: 'new',
      resolved: false,
    });
    return { id: ref.id };
  }

  async listSupportTickets(user: AuthenticatedUser, scope?: string) {
    const db = this.firebaseAdmin.db();
    const admin = this.isSupportAgent(user);
    if (scope === 'all' && !admin) {
      throw new ForbiddenException('Support staff access required.');
    }
    const collection = db.collection('support-tickets');
    if (admin && scope === 'all') {
      const snapshot = await collection.orderBy('createdAt', 'desc').limit(500).get();
      return { tickets: snapshot.docs.map(doc => this.ticketData(doc.id, doc.data())) };
    }
    const [byUid, byEmail] = await Promise.all([
      collection.where('userId', '==', user.uid).limit(200).get(),
      collection.where('email', '==', user.email).limit(200).get(),
    ]);
    const docs = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
    [...byUid.docs, ...byEmail.docs].forEach(doc => docs.set(doc.id, doc));
    return {
      tickets: [...docs.values()]
        .map(doc => this.ticketData(doc.id, doc.data()))
        .sort((a, b) => this.timestampMillis(b.createdAt) - this.timestampMillis(a.createdAt)),
    };
  }

  async createSupportTicket(user: AuthenticatedUser, input: unknown) {
    const body = this.requireObject(input);
    const title = this.requiredString(body.title, 'title', 200);
    const message = this.requiredString(body.message, 'message', 10_000);
    const priority = body.priority ?? 'low';
    if (!['low', 'medium', 'high', 'urgent'].includes(String(priority))) {
      throw new BadRequestException('Invalid support ticket priority.');
    }
    const userData = (await this.userRef(user).get()).data() || {};
    const now = Date.now();
    const requestedId =
      body.requestedId === undefined
        ? ''
        : this.optionalString(body.requestedId, 'requestedId', 40);
    if (requestedId && !/^[A-Z0-9-]{6,40}$/.test(requestedId)) {
      throw new BadRequestException('Invalid support ticket id.');
    }
    const ticketRef = this.firebaseAdmin
      .db()
      .collection('support-tickets')
      .doc(requestedId || `TICKET-${randomUUID().slice(0, 12).toUpperCase()}`);
    const ticket = {
      title,
      message,
      createdAt: FieldValue.serverTimestamp(),
      email: user.email,
      userId: user.uid,
      status: 'open',
      priority,
      userName: this.stringValue(userData.fullname, user.email),
      updatedAt: FieldValue.serverTimestamp(),
      overdue: false,
      hasAgentReply: false,
      lastAgentReplyAt: null,
    };
    await ticketRef.create(ticket);
    return { ticket: { id: ticketRef.id, ...ticket, createdAt: now, updatedAt: now } };
  }

  async getSupportTicket(user: AuthenticatedUser, ticketId: string) {
    const snapshot = await this.firebaseAdmin
      .db()
      .collection('support-tickets')
      .doc(ticketId)
      .get();
    if (!snapshot.exists) throw new NotFoundException('Support ticket not found.');
    const ticket = snapshot.data() || {};
    this.assertCanAccessTicket(user, ticket);
    const messages = await snapshot.ref
      .collection('messages')
      .orderBy('createdAtServer', 'asc')
      .limit(200)
      .get();
    return {
      ticket: this.ticketData(snapshot.id, ticket),
      messages: messages.docs.map(doc => ({
        id: doc.id,
        ...this.toPlainObject(doc.data()),
      })),
    };
  }

  async replyToSupportTicket(
    user: AuthenticatedUser,
    ticketId: string,
    input: unknown,
  ) {
    const body = this.requireObject(input);
    const text = this.requiredString(body.text, 'text', 10_000);
    const ticketRef = this.firebaseAdmin
      .db()
      .collection('support-tickets')
      .doc(ticketId);
    const snapshot = await ticketRef.get();
    if (!snapshot.exists) throw new NotFoundException('Support ticket not found.');
    const ticket = snapshot.data() || {};
    const agent = this.isSupportAgent(user);
    this.assertCanAccessTicket(user, ticket);
    const userData = (await this.userRef(user).get()).data() || {};
    await ticketRef.collection('messages').add({
      text,
      senderId: user.uid,
      senderEmail: user.email,
      senderName: this.stringValue(userData.fullname, agent ? 'Agent' : user.email),
      direction: agent ? 'agent' : 'user',
      createdAtServer: FieldValue.serverTimestamp(),
    });
    await ticketRef.update({
      updatedAt: FieldValue.serverTimestamp(),
      updatedAtServer: FieldValue.serverTimestamp(),
      ...(agent
        ? { hasAgentReply: true, lastAgentReplyAt: FieldValue.serverTimestamp() }
        : {}),
    });
    return { sent: true };
  }

  async listAdminUsers(user: AuthenticatedUser) {
    this.assertAdmin(user);
    const snapshot = await this.firebaseAdmin
      .db()
      .collection('users')
      .orderBy('createdAt', 'desc')
      .limit(500)
      .get();
    return {
      users: snapshot.docs.map(doc => ({
        id: doc.id,
        ...this.toPlainObject(doc.data()),
        uid: doc.data().uid || doc.id,
      })),
    };
  }

  async updateAdminUserRoles(user: AuthenticatedUser, input: unknown) {
    this.assertAdmin(user);
    const body = this.requireObject(input);
    const email = this.requiredString(body.email, 'email', 254).toLowerCase();
    if (email === user.email.toLowerCase()) {
      throw new BadRequestException('You cannot change your own admin roles.');
    }
    const roles = this.requireArray(body.roles, 'roles', 20).map(role =>
      this.requiredString(role, 'role', 40),
    );
    const allowedRoles = new Set([
      'admin',
      'founder',
      'viewer',
      'support',
      'manager',
      'student',
    ]);
    if (roles.some(role => !allowedRoles.has(role))) {
      throw new BadRequestException('One or more roles are not supported.');
    }
    const userRef = this.firebaseAdmin.db().collection('users').doc(email);
    const snapshot = await userRef.get();
    if (!snapshot.exists) throw new NotFoundException('User not found.');
    await userRef.set(
      { roles, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return { email, roles };
  }

  async deleteAdminUser(user: AuthenticatedUser, emailInput: string) {
    this.assertAdmin(user);
    const email = decodeURIComponent(emailInput).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('Valid user email required.');
    }
    if (email === user.email.toLowerCase()) {
      throw new BadRequestException('You cannot delete your own account.');
    }
    const userRef = this.firebaseAdmin.db().collection('users').doc(email);
    const snapshot = await userRef.get();
    if (!snapshot.exists) throw new NotFoundException('User not found.');
    const targetUid = this.stringValue(snapshot.data()?.uid);
    if (targetUid) {
      try {
        await this.firebaseAdmin.auth().deleteUser(targetUid);
      } catch (error) {
        if ((error as { code?: string }).code !== 'auth/user-not-found') {
          throw error;
        }
      }
    }
    await userRef.delete();
    return { deleted: true };
  }

  async listAdminReports(user: AuthenticatedUser) {
    this.assertAdmin(user);
    const snapshot = await this.firebaseAdmin
      .db()
      .collection('reports')
      .orderBy('reportedAt', 'desc')
      .limit(500)
      .get();
    return {
      reports: snapshot.docs.map(doc => ({
        id: doc.id,
        ...this.toPlainObject(doc.data()),
      })),
    };
  }

  async getAdminMetrics(user: AuthenticatedUser) {
    this.assertAdmin(user);
    const db = this.firebaseAdmin.db();
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const collectionCounts = async (name: string, dateField: string) => {
      const collection = db.collection(name);
      const [total, monthly] = await Promise.all([
        collection.count().get(),
        collection.where(dateField, '>=', monthStart).count().get(),
      ]);
      return { total: total.data().count, monthly: monthly.data().count };
    };
    const [users, courses, videos, apiKeys, openTickets, pendingTickets, resolvedTickets, overdueTickets, unreadTickets] = await Promise.all([
      collectionCounts('users', 'createdAt'),
      collectionCounts('course', 'createdOn'),
      collectionCounts('videos', 'uploadedAt'),
      collectionCounts('api_keys', 'createdAt'),
      db.collection('support-tickets').where('status', '==', 'open').count().get(),
      db.collection('support-tickets').where('status', '==', 'pending').count().get(),
      db.collection('support-tickets').where('status', '==', 'resolved').count().get(),
      db.collection('support-tickets').where('overdue', '==', true).count().get(),
      db.collection('support-tickets').where('hasAgentReply', '==', false).count().get(),
    ]);
    return {
      totalUsers: users.total,
      monthlyUsers: users.monthly,
      totalCourses: courses.total,
      monthlyCourses: courses.monthly,
      totalVideos: videos.total,
      monthlyVideos: videos.monthly,
      totalAPIKeys: apiKeys.total,
      monthlyAPIKeys: apiKeys.monthly,
      openTickets: openTickets.data().count,
      pendingTickets: pendingTickets.data().count,
      resolvedTickets: resolvedTickets.data().count,
      overdueTickets: overdueTickets.data().count,
      unreadTickets: unreadTickets.data().count,
    };
  }

  async getAdminUserActivity(user: AuthenticatedUser) {
    this.assertAdmin(user);
    const snapshot = await this.firebaseAdmin
      .db()
      .collection('userActivity')
      .orderBy('date', 'desc')
      .limit(365)
      .get();
    return {
      activity: snapshot.docs
        .map(doc => ({
          date: this.stringValue(doc.data().id, doc.id),
          desktop: Number(doc.data().desktop) || 0,
          mobile: Number(doc.data().mobile) || 0,
        }))
        .reverse(),
    };
  }

  async createVideoUploadUrls(user: AuthenticatedUser, input: unknown) {
    this.assertCanUploadVideo(user);
    const body = this.requireObject(input);
    const videoContentType = this.requiredString(
      body.videoContentType,
      'videoContentType',
      100,
    );
    const thumbnailContentType = this.requiredString(
      body.thumbnailContentType,
      'thumbnailContentType',
      100,
    );
    if (!videoContentType.startsWith('video/')) {
      throw new BadRequestException('A video file is required.');
    }
    if (!thumbnailContentType.startsWith('image/')) {
      throw new BadRequestException('An image thumbnail is required.');
    }

    const uploadId = randomUUID();
    const videoPath = `videos/${user.uid}/${uploadId}/video`;
    const thumbnailPath = `videos/${user.uid}/${uploadId}/thumbnail`;
    const bucket = this.firebaseAdmin.storageBucket();
    const expires = Date.now() + 5 * 60 * 1000;
    const [videoUploadUrl, thumbnailUploadUrl] = await Promise.all([
      bucket.file(videoPath).getSignedUrl({
        action: 'write',
        contentType: videoContentType,
        expires,
        version: 'v4',
      }),
      bucket.file(thumbnailPath).getSignedUrl({
        action: 'write',
        contentType: thumbnailContentType,
        expires,
        version: 'v4',
      }),
    ]);

    return {
      uploadId,
      videoUploadUrl: videoUploadUrl[0],
      thumbnailUploadUrl: thumbnailUploadUrl[0],
    };
  }

  async completeVideoUpload(
    user: AuthenticatedUser,
    uploadId: string,
    input: unknown,
  ) {
    this.assertCanUploadVideo(user);
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) {
      throw new BadRequestException('Invalid upload id.');
    }

    const body = this.requireObject(input);
    const title = this.requiredString(body.title, 'title', 200);
    const instructorCompany = this.requiredString(
      body.instructorCompany,
      'instructorCompany',
      200,
    );
    const instructorName = this.requiredString(
      body.instructorName,
      'instructorName',
      200,
    );
    const description = this.requiredString(body.description, 'description', 20_000);
    const category = this.requiredString(body.category, 'category', 120);
    const visibility = body.visibility;
    if (visibility !== 'public' && visibility !== 'private') {
      throw new BadRequestException('Invalid video visibility.');
    }
    const level = body.level;
    if (level !== 'beginner' && level !== 'advance') {
      throw new BadRequestException('Invalid video level.');
    }
    const topics = this.requireArray(body.topics, 'topics', 100).map(topic =>
      this.requiredString(topic, 'topic', 100),
    );
    const duration = Number(body.duration);
    if (!Number.isFinite(duration) || duration < 0 || duration > 24 * 60 * 60) {
      throw new BadRequestException('Invalid video duration.');
    }

    const bucket = this.firebaseAdmin.storageBucket();
    const videoFile = bucket.file(`videos/${user.uid}/${uploadId}/video`);
    const thumbnailFile = bucket.file(
      `videos/${user.uid}/${uploadId}/thumbnail`,
    );
    const [[videoExists], [thumbnailExists]] = await Promise.all([
      videoFile.exists(),
      thumbnailFile.exists(),
    ]);
    if (!videoExists || !thumbnailExists) {
      throw new BadRequestException('Both video and thumbnail uploads are required.');
    }

    const [videoMetadata] = await videoFile.getMetadata();
    const [thumbnailMetadata] = await thumbnailFile.getMetadata();
    const videoBytes = Number(videoMetadata.size || 0);
    const thumbnailBytes = Number(thumbnailMetadata.size || 0);
    if (
      !String(videoMetadata.contentType || '').startsWith('video/') ||
      videoBytes <= 0 ||
      videoBytes > 512 * 1024 * 1024
    ) {
      throw new BadRequestException('The uploaded video is invalid or too large.');
    }
    if (
      !String(thumbnailMetadata.contentType || '').startsWith('image/') ||
      thumbnailBytes <= 0 ||
      thumbnailBytes > 10 * 1024 * 1024
    ) {
      throw new BadRequestException('The uploaded thumbnail is invalid or too large.');
    }

    const videoRef = this.firebaseAdmin.db().collection('videos').doc(uploadId);
    if ((await videoRef.get()).exists) {
      throw new BadRequestException('This video upload has already been completed.');
    }

    const videoDownloadToken = randomUUID();
    const thumbnailDownloadToken = randomUUID();
    await Promise.all([
      videoFile.setMetadata({
        metadata: { firebaseStorageDownloadTokens: videoDownloadToken },
      }),
      thumbnailFile.setMetadata({
        metadata: {
          firebaseStorageDownloadTokens: thumbnailDownloadToken,
        },
      }),
    ]);

    const bucketName = encodeURIComponent(bucket.name);
    const videoURL = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(videoFile.name)}?alt=media&token=${videoDownloadToken}`;
    const thumbnailURL = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(thumbnailFile.name)}?alt=media&token=${thumbnailDownloadToken}`;
    const video = {
      id: uploadId,
      title,
      instructorCompany,
      instructorName,
      description,
      videoURL,
      thumbnailURL,
      category,
      uploadedBy: user.email,
      uploadedAt: FieldValue.serverTimestamp(),
      visibility,
      duration,
      level,
      views: 0,
      topics,
    };

    await videoRef.create(video);

    return { video: { ...video, id: uploadId } };
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
    if (this.videosCache && this.videosCache.expiresAt > Date.now()) {
      return this.videosCache.videos;
    }
    if (this.videosRequest) return this.videosRequest;

    const db = this.firebaseAdmin.db();
    const request = Promise.all([
      db.collection('videos').get(),
      db.collection('youTubeVideos').get(),
    ]).then(([uploadedSnap, youtubeSnap]) => {
      const videos = [
        ...uploadedSnap.docs
          .map(doc => this.toUploadedVideo(doc.id, doc.data()))
          .filter(video => video.visibility === 'public'),
        ...youtubeSnap.docs.map(doc => this.toYouTubeVideo(doc.id, doc.data())),
      ].sort(
        (a, b) =>
          this.timestampMillis(b.uploadedAt || b.createdAt) -
          this.timestampMillis(a.uploadedAt || a.createdAt),
      );
      this.videosCache = {
        videos,
        expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
      };
      return videos;
    });
    this.videosRequest = request;
    try {
      return await request;
    } finally {
      if (this.videosRequest === request) this.videosRequest = undefined;
    }
  }

  private async loadCourses() {
    if (this.coursesCache && this.coursesCache.expiresAt > Date.now()) {
      return this.coursesCache.courses;
    }
    if (this.coursesRequest) return this.coursesRequest;

    const request = this.firebaseAdmin
      .db()
      .collection('course')
      .get()
      .then(snapshot => {
        const courses = snapshot.docs
          .map(doc => this.toCourse(doc.id, doc.data()))
          .filter(course => this.isCanonicalCourse(course))
          .sort(
            (a, b) =>
              this.timestampMillis(b.createdOn) -
              this.timestampMillis(a.createdOn),
          );
        this.coursesCache = {
          courses,
          expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
        };
        return courses;
      });
    this.coursesRequest = request;
    try {
      return await request;
    } finally {
      if (this.coursesRequest === request) this.coursesRequest = undefined;
    }
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

  private assertCanUploadVideo(user: AuthenticatedUser) {
    if (!user.roles.includes('admin')) {
      throw new ForbiddenException('You are not authorized to upload videos.');
    }
  }

  private assertAdmin(user: AuthenticatedUser) {
    if (!user.roles.includes('admin')) {
      throw new ForbiddenException('Administrator access required.');
    }
  }

  private isSupportAgent(user: AuthenticatedUser) {
    return user.roles.some(role =>
      ['admin', 'support', 'manager', 'founder'].includes(role),
    );
  }

  private assertCanAccessTicket(user: AuthenticatedUser, ticket: PlainObject) {
    if (this.isSupportAgent(user)) return;
    if (
      ticket.userId === user.uid ||
      String(ticket.email || '').toLowerCase() === user.email.toLowerCase()
    ) {
      return;
    }
    throw new ForbiddenException('You are not authorized to access this ticket.');
  }

  private ticketData(id: string, data: PlainObject) {
    return {
      id,
      ...this.toPlainObject(data),
      createdAt: data.createdAt || null,
      updatedAt: data.updatedAt || null,
      lastAgentReplyAt: data.lastAgentReplyAt || null,
    };
  }

  private reviewRating(value: unknown) {
    const rating = Number(value);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new BadRequestException('Rating must be a whole number from 1 to 5.');
    }
    return rating;
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

  private requireArray(value: unknown, field: string, maxLength: number) {
    if (!Array.isArray(value) || value.length > maxLength) {
      throw new BadRequestException(`${field} must be a list of at most ${maxLength} items.`);
    }
    return value;
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
