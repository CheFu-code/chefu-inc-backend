import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

type CourseDocument = {
  createdBy?: string;
  chapters?: Array<{
    chapterName?: string;
    content?: Array<{
      topic?: string;
      explain?: string;
      code?: string;
      example?: string;
    }>;
  }>;
  completedChapter?: string[];
  [key: string]: unknown;
};

@Injectable()
export class CoursesService {
  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

  async getLearningCourse(
    user: AuthenticatedUser,
    courseId: string,
    chapterIndex: number,
  ) {
    const { course, userProfile } = await this.getOwnedCourseAndProfile(
      user,
      courseId,
    );

    this.assertChapterExists(course, chapterIndex);
    this.assertCanOpenChapter(course, userProfile, chapterIndex);

    return {
      course: {
        id: courseId,
        ...course,
      },
    };
  }

  async saveResume(
    user: AuthenticatedUser,
    courseId: string,
    chapterIndex: number,
    contentIndex: number,
  ) {
    const { course, userProfile, courseRef } = await this.getOwnedCourseAndProfile(
      user,
      courseId,
    );

    const chapter = this.assertChapterExists(course, chapterIndex);
    const content = this.assertContentExists(chapter, contentIndex);
    this.assertCanOpenChapter(course, userProfile, chapterIndex);

    await courseRef.update({
      lastStudiedAt: FieldValue.serverTimestamp(),
      lastStudiedChapterIndex: chapterIndex,
      lastStudiedContentIndex: contentIndex,
      lastStudiedChapterName: chapter.chapterName || '',
      lastStudiedTopic: content.topic || '',
    });

    return { success: true };
  }

  async completeChapter(
    user: AuthenticatedUser,
    courseId: string,
    chapterIndex: number,
  ) {
    const { course, userProfile, courseRef } = await this.getOwnedCourseAndProfile(
      user,
      courseId,
    );

    this.assertChapterExists(course, chapterIndex);
    this.assertCanOpenChapter(course, userProfile, chapterIndex);

    await courseRef.update({
      completedChapter: FieldValue.arrayUnion(chapterIndex.toString()),
    });

    return { success: true };
  }

  private async getOwnedCourseAndProfile(
    user: AuthenticatedUser,
    courseId: string,
  ) {
    if (!courseId) {
      throw new BadRequestException('Course id required.');
    }

    const db = this.firebaseAdmin.db();
    const [courseSnap, userSnap] = await Promise.all([
      db.collection('course').doc(courseId).get(),
      db.collection('users').doc(user.email).get(),
    ]);

    if (!courseSnap.exists) {
      throw new NotFoundException('Course not found.');
    }

    const course = courseSnap.data() as CourseDocument;
    if (course.createdBy !== user.email) {
      throw new ForbiddenException('You are not authorized to view this course.');
    }

    return {
      course,
      userProfile: userSnap.data() || {},
      courseRef: courseSnap.ref,
    };
  }

  private assertCanOpenChapter(
    course: CourseDocument,
    userProfile: FirebaseFirestore.DocumentData,
    chapterIndex: number,
  ) {
    const completedChapters = Array.isArray(course.completedChapter)
      ? course.completedChapter.map(String)
      : [];
    const isCompleted = completedChapters.includes(chapterIndex.toString());

    if (isCompleted && userProfile.member !== true) {
      throw new ForbiddenException(
        'Chapter completed, subscribe to revisit this chapter.',
      );
    }
  }

  private assertChapterExists(course: CourseDocument, chapterIndex: number) {
    if (!Number.isInteger(chapterIndex) || chapterIndex < 0) {
      throw new BadRequestException('Invalid chapter index.');
    }

    const chapter = course.chapters?.[chapterIndex];
    if (!chapter) {
      throw new NotFoundException('Chapter not found.');
    }

    return chapter;
  }

  private assertContentExists(
    chapter: NonNullable<CourseDocument['chapters']>[number],
    contentIndex: number,
  ) {
    if (!Number.isInteger(contentIndex) || contentIndex < 0) {
      throw new BadRequestException('Invalid lesson index.');
    }

    const content = chapter.content?.[contentIndex];
    if (!content) {
      throw new NotFoundException('Lesson not found.');
    }

    return content;
  }
}
