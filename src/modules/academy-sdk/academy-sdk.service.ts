import { Injectable } from '@nestjs/common';
import { AcademySdkApiKey, AcademySdkUser } from './academy-sdk.types';
import { AcademySdkApiKeysService } from './services/academy-sdk-api-keys.service';
import { AcademySdkAuthService } from './services/academy-sdk-auth.service';
import { AcademySdkCatalogService } from './services/academy-sdk-catalog.service';

type LoginBody = {
  email?: string;
  password?: string;
};

type RegisterBody = LoginBody & {
  fullname?: string;
};

type RefreshBody = {
  refreshToken?: string;
};

type ApiKeyLeakReport = {
  apiKey?: string;
  leakedKey?: string;
  source?: string;
  url?: string;
  repository?: string;
  commit?: string;
};

type LeakRequestMeta = {
  ip?: string;
  userAgent?: string;
};

type ListQuery = {
  query?: string;
  category?: string;
  limit?: string | number;
};

@Injectable()
export class AcademySdkService {
  constructor(
    private readonly authService: AcademySdkAuthService,
    private readonly apiKeysService: AcademySdkApiKeysService,
    private readonly catalogService: AcademySdkCatalogService,
  ) {}

  verifyApiKey(apiKey?: AcademySdkApiKey) {
    return this.apiKeysService.verifyApiKey(apiKey);
  }

  login(body: LoginBody) {
    return this.authService.login(body);
  }

  register(body: RegisterBody) {
    return this.authService.register(body);
  }

  refreshSession(body: RefreshBody) {
    return this.authService.refreshSession(body);
  }

  createApiKey(user: AcademySdkUser, name?: string) {
    return this.apiKeysService.createApiKey(user, name);
  }

  listApiKeys(user: AcademySdkUser) {
    return this.apiKeysService.listApiKeys(user);
  }

  revokeApiKey(user: AcademySdkUser, keyId?: string) {
    return this.apiKeysService.revokeApiKey(user, keyId);
  }

  reportLeakedApiKey(report: ApiKeyLeakReport, meta?: LeakRequestMeta) {
    return this.apiKeysService.reportLeakedApiKey(report, meta);
  }

  listCourses(options: ListQuery = {}) {
    return this.catalogService.listCourses(options);
  }

  searchCourses(options: ListQuery = {}) {
    return this.catalogService.searchCourses(options);
  }

  getFeaturedCourses(options: Pick<ListQuery, 'limit'> = {}) {
    return this.catalogService.getFeaturedCourses(options);
  }

  getCourseCategories() {
    return this.catalogService.getCourseCategories();
  }

  getCourseById(courseId?: string) {
    return this.catalogService.getCourseById(courseId);
  }

  getCourseChapters(courseId?: string) {
    return this.catalogService.getCourseChapters(courseId);
  }

  getCourseChapter(courseId: string | undefined, chapterIndex: number) {
    return this.catalogService.getCourseChapter(courseId, chapterIndex);
  }

  getCourseLessons(courseId: string | undefined, chapterIndex: number) {
    return this.catalogService.getCourseLessons(courseId, chapterIndex);
  }

  getCourseQuiz(courseId?: string) {
    return this.catalogService.getCourseQuiz(courseId);
  }

  getCourseFlashcards(courseId?: string) {
    return this.catalogService.getCourseFlashcards(courseId);
  }

  getCourseQA(courseId?: string) {
    return this.catalogService.getCourseQA(courseId);
  }

  listVideos(options: ListQuery = {}) {
    return this.catalogService.listVideos(options);
  }

  searchVideos(options: ListQuery = {}) {
    return this.catalogService.searchVideos(options);
  }

  getVideoById(videoId?: string) {
    return this.catalogService.getVideoById(videoId);
  }
}
