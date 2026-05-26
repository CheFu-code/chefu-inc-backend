import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FirebaseAdminService } from '../../firebase-admin/firebase-admin.service';

type ListQuery = {
  query?: string;
  category?: string;
  limit?: string | number;
};

type CourseDocument = Record<string, unknown> & {
  id: string;
  courseTitle?: string;
  title?: string;
  description?: string;
  category?: string;
  enrolled?: boolean;
  originalCourseId?: string;
  chapters?: unknown[];
  quiz?: unknown[];
  flashcards?: unknown[];
  qa?: unknown[];
};

type VideoDocument = Record<string, unknown> & {
  id: string;
  source: 'uploaded' | 'youtube';
  videoId?: string;
  youtubeVideoId?: string;
  title?: string;
  description?: string;
  category?: string;
  visibility?: string;
};

@Injectable()
export class AcademySdkCatalogService {
  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

  async listCourses(options: ListQuery = {}) {
    const courses = await this.loadCourses();
    const filtered = this.filterCourses(courses, options);

    return {
      courses: filtered.slice(0, this.parseLimit(options.limit, 50, 100)),
      total: filtered.length,
    };
  }

  async searchCourses(options: ListQuery = {}) {
    return this.listCourses(options);
  }

  async getFeaturedCourses(options: Pick<ListQuery, 'limit'> = {}) {
    const courses = (await this.loadCourses())
      .filter(course => this.isCanonicalCourse(course))
      .sort((a, b) => this.courseQualityScore(b) - this.courseQualityScore(a));

    return {
      courses: courses.slice(0, this.parseLimit(options.limit, 12, 50)),
      total: courses.length,
    };
  }

  async getCourseCategories() {
    const courses = await this.loadCourses();
    const categories = Array.from(
      new Set(
        courses
          .filter(course => this.isCanonicalCourse(course))
          .map(course => String(course.category || '').trim())
          .filter(Boolean),
      ),
    ).sort((a, b) => a.localeCompare(b));

    return {
      categories,
      total: categories.length,
    };
  }

  async getCourseById(courseId?: string) {
    if (!courseId) {
      throw new BadRequestException('Invalid course ID.');
    }

    const snapshot = await this.firebaseAdmin
      .db()
      .collection('course')
      .doc(courseId)
      .get();

    if (!snapshot.exists) {
      throw new NotFoundException('Course not found.');
    }

    return {
      id: snapshot.id,
      ...(this.toPlainObject(snapshot.data() || {}) as Record<string, unknown>),
    } as CourseDocument;
  }

  async getCourseChapters(courseId?: string) {
    const course = await this.getCourseById(courseId);
    return {
      courseId: course.id,
      chapters: this.arrayValue(course.chapters),
    };
  }

  async getCourseChapter(courseId: string | undefined, chapterIndex: number) {
    const { courseId: id, chapters } = await this.getCourseChapters(courseId);
    const chapter = this.requireArrayItem(chapters, chapterIndex, 'Chapter');

    return {
      courseId: id,
      chapterIndex,
      chapter,
    };
  }

  async getCourseLessons(courseId: string | undefined, chapterIndex: number) {
    const { courseId: id, chapter } = await this.getCourseChapter(
      courseId,
      chapterIndex,
    );
    const content =
      typeof chapter === 'object' &&
      chapter !== null &&
      Array.isArray((chapter as { content?: unknown[] }).content)
        ? (chapter as { content: unknown[] }).content
        : [];

    return {
      courseId: id,
      chapterIndex,
      lessons: content,
    };
  }

  async getCourseQuiz(courseId?: string) {
    const course = await this.getCourseById(courseId);
    return {
      courseId: course.id,
      quiz: this.arrayValue(course.quiz),
    };
  }

  async getCourseFlashcards(courseId?: string) {
    const course = await this.getCourseById(courseId);
    return {
      courseId: course.id,
      flashcards: this.arrayValue(course.flashcards),
    };
  }

  async getCourseQA(courseId?: string) {
    const course = await this.getCourseById(courseId);
    return {
      courseId: course.id,
      qa: this.arrayValue(course.qa),
    };
  }

  async listVideos(options: ListQuery = {}) {
    const videos = this.filterVideos(await this.loadVideos(), options);

    return {
      videos: videos.slice(0, this.parseLimit(options.limit, 50, 100)),
      total: videos.length,
    };
  }

  async searchVideos(options: ListQuery = {}) {
    return this.listVideos(options);
  }

  async getVideoById(videoId?: string) {
    if (!videoId) {
      throw new BadRequestException('Invalid video ID.');
    }

    const db = this.firebaseAdmin.db();
    const [uploadedSnap, youtubeSnap] = await Promise.all([
      db.collection('videos').doc(videoId).get(),
      db.collection('youTubeVideos').doc(videoId).get(),
    ]);

    if (uploadedSnap.exists) {
      const video = this.toUploadedVideo(uploadedSnap.id, uploadedSnap.data() || {});
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

  private async loadCourses() {
    const snapshot = await this.firebaseAdmin.db().collection('course').get();
    return snapshot.docs
      .map(doc => this.toCourse(doc.id, doc.data()))
      .filter(course => this.isCanonicalCourse(course))
      .sort(
        (a, b) =>
          this.timestampMillis(b.createdOn) - this.timestampMillis(a.createdOn),
      );
  }

  private toCourse(id: string, data: FirebaseFirestore.DocumentData) {
    const course = this.toPlainObject(data) as CourseDocument;

    return {
      ...course,
      id,
      docId: course.docId || id,
      courseTitle: course.courseTitle || course.title || 'Untitled course',
      description: course.description || '',
      category: course.category || '',
      chapters: this.arrayValue(course.chapters),
      quiz: this.arrayValue(course.quiz),
      flashcards: this.arrayValue(course.flashcards),
      qa: this.arrayValue(course.qa),
    } as CourseDocument;
  }

  private filterCourses(courses: CourseDocument[], options: ListQuery) {
    const category = String(options.category || '').trim().toLowerCase();
    const query = String(options.query || '').trim().toLowerCase();

    return courses
      .filter(course => {
        if (!category) return true;
        return String(course.category || '').trim().toLowerCase() === category;
      })
      .map(course => ({
        course,
        score: this.courseSearchScore(course, query),
      }))
      .filter(item => !query || item.score > 0)
      .sort((a, b) =>
        query
          ? b.score - a.score
          : this.timestampMillis(b.course.createdOn) -
            this.timestampMillis(a.course.createdOn),
      )
      .map(item => item.course);
  }

  private isCanonicalCourse(course: CourseDocument) {
    return !course.enrolled && !course.originalCourseId;
  }

  private courseSearchScore(course: CourseDocument, query: string) {
    if (!query) return 1;

    const title = String(course.courseTitle || course.title || '').toLowerCase();
    const category = String(course.category || '').toLowerCase();
    const description = String(course.description || '').toLowerCase();
    let score = 0;

    if (title === query) score += 30;
    if (category === query) score += 20;
    if (title.includes(query)) score += 12;
    if (category.includes(query)) score += 8;
    if (description.includes(query)) score += 4;

    query
      .split(/[^a-z0-9]+/i)
      .filter(token => token.length > 1)
      .forEach(token => {
        if (title.includes(token)) score += 5;
        if (category.includes(token)) score += 4;
        if (description.includes(token)) score += 2;
      });

    return score + this.courseQualityScore(course) * 0.1;
  }

  private courseQualityScore(course: CourseDocument) {
    const chapters = this.arrayValue(course.chapters);
    const quiz = this.arrayValue(course.quiz);
    const flashcards = this.arrayValue(course.flashcards);
    const qa = this.arrayValue(course.qa);
    const averageRating = Number(course.averageRating || 0) || 0;
    const reviewCount = Number(course.reviewCount || 0) || 0;

    return (
      Math.min(chapters.length, 12) * 2 +
      Math.min(quiz.length, 20) * 0.4 +
      Math.min(flashcards.length, 20) * 0.3 +
      Math.min(qa.length, 20) * 0.3 +
      averageRating * 3 +
      Math.min(reviewCount, 50) * 0.15
    );
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
        this.timestampMillis(b.uploadedAt) - this.timestampMillis(a.uploadedAt),
    );
  }

  private toUploadedVideo(id: string, data: FirebaseFirestore.DocumentData) {
    const video = this.toPlainObject(data) as Record<string, unknown>;

    return {
      ...video,
      id,
      source: 'uploaded',
      title: this.stringValue(video.title, 'Untitled video'),
      instructorCompany: this.stringValue(video.instructorCompany),
      instructorName: this.stringValue(video.instructorName),
      description: this.stringValue(video.description),
      videoURL: this.stringValue(video.videoURL || video.url),
      thumbnailURL: this.stringValue(video.thumbnailURL || video.thumbnail),
      uploadedBy: this.stringValue(video.uploadedBy),
      uploadedAt: video.uploadedAt || null,
      category: this.stringValue(video.category, 'Tech & Coding'),
      visibility: this.stringValue(video.visibility, 'public'),
      level: this.stringValue(video.level),
      duration: Number(video.duration || 0),
      views: Number(video.views || 0),
      topics: this.arrayValue(video.topics),
    } as VideoDocument;
  }

  private toYouTubeVideo(id: string, data: FirebaseFirestore.DocumentData) {
    const video = this.toPlainObject(data) as Record<string, unknown>;
    const youtubeVideoId = String(video.videoId || '').trim();

    return {
      ...video,
      id,
      source: 'youtube',
      videoId: youtubeVideoId,
      youtubeVideoId,
      title: this.stringValue(video.title, 'Untitled YouTube video'),
      instructorCompany: this.stringValue(video.instructorCompany, 'YouTube'),
      instructorName: this.stringValue(
        video.instructorName || video.channelTitle,
        'YouTube',
      ),
      description:
        this.stringValue(video.description) ||
        'A curated YouTube lesson selected for CheFu Academy learners.',
      videoURL: youtubeVideoId ? this.youtubeWatchUrl(youtubeVideoId) : '',
      embedURL: youtubeVideoId
        ? this.youtubeEmbedUrl(youtubeVideoId)
        : undefined,
      thumbnailURL: this.stringValue(video.thumbnailURL || video.thumbnail),
      uploadedBy: this.stringValue(
        video.uploadedBy || video.channelTitle,
        'YouTube',
      ),
      uploadedAt: video.uploadedAt || video.createdAt || null,
      category: this.stringValue(video.category, 'Tech & Coding'),
      visibility: this.stringValue(video.visibility, 'public'),
      level: this.stringValue(video.level, 'beginner'),
      duration: Number(video.duration || 0),
      views: Number(video.views || 0),
      topics: this.arrayValue(video.topics),
    } as VideoDocument;
  }

  private filterVideos(videos: VideoDocument[], options: ListQuery) {
    const category = String(options.category || '').trim().toLowerCase();
    const query = String(options.query || '').trim().toLowerCase();

    return videos.filter(video => {
      const matchesCategory =
        !category ||
        String(video.category || '').trim().toLowerCase() === category;
      const searchable = [
        video.title,
        video.category,
        video.description,
        ...(Array.isArray(video.topics) ? video.topics : []),
      ]
        .map(value => String(value || '').toLowerCase())
        .join(' ');

      return matchesCategory && (!query || searchable.includes(query));
    });
  }

  private requireArrayItem(values: unknown[], index: number, label: string) {
    if (!Number.isInteger(index) || index < 0) {
      throw new BadRequestException(`Invalid ${label.toLowerCase()} index.`);
    }

    const value = values[index];
    if (!value) {
      throw new NotFoundException(`${label} not found.`);
    }

    return value;
  }

  private parseLimit(
    value: string | number | undefined,
    defaultValue: number,
    max: number,
  ) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;

    return Math.min(Math.floor(parsed), max);
  }

  private arrayValue(value: unknown) {
    return Array.isArray(value) ? value : [];
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
    return this.toPlainValue(data) as Record<string, unknown>;
  }

  private toPlainValue(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(item => this.toPlainValue(item));
    if (!value || typeof value !== 'object') return value;

    if ('toDate' in value && typeof value.toDate === 'function') {
      return value.toDate().toISOString();
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        this.toPlainValue(item),
      ]),
    );
  }

  private youtubeWatchUrl(videoId: string) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  }

  private youtubeEmbedUrl(videoId: string) {
    return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}`;
  }
}
