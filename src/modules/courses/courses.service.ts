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
      completedChapterEvents: FieldValue.arrayUnion({
        chapterIndex,
        completedAt: new Date().toISOString(),
      }),
    });

    return { success: true };
  }

  async generateCoursePdf(user: AuthenticatedUser, courseId: string) {
    const { course } = await this.getDownloadableCourse(user, courseId);
    const html = this.renderCourseHtml(courseId, course);
    const { default: puppeteer } = await import('puppeteer');
    const browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true,
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        margin: {
          top: '18mm',
          right: '16mm',
          bottom: '20mm',
          left: '16mm',
        },
        headerTemplate: '<div></div>',
        footerTemplate:
          '<div style="width:100%;font-size:9px;color:#64748b;padding:0 16mm;display:flex;justify-content:space-between;font-family:Inter,Arial,sans-serif;"><span>CheFu Academy</span><span class="pageNumber"></span></div>',
      });

      return {
        buffer: Buffer.from(pdf),
        fileName: `${this.safeFileName(String(course.courseTitle || 'course'))}.pdf`,
      };
    } finally {
      await browser.close();
    }
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
    if (!this.isOwner(course.createdBy, user.email)) {
      throw new ForbiddenException('You are not authorized to view this course.');
    }

    return {
      course,
      userProfile: userSnap.data() || {},
      courseRef: courseSnap.ref,
    };
  }

  private async getDownloadableCourse(user: AuthenticatedUser, courseId: string) {
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
    const isOwner = this.isOwner(course.createdBy, user.email);
    const isCanonical = !course.enrolled && !course.originalCourseId;

    if (!isOwner && !isCanonical) {
      throw new ForbiddenException('You are not authorized to download this course.');
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

  private isOwner(courseOwnerEmail?: string, userEmail?: string) {
    return (
      Boolean(courseOwnerEmail && userEmail) &&
      String(courseOwnerEmail).trim().toLowerCase() ===
        String(userEmail).trim().toLowerCase()
    );
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

  private renderCourseHtml(courseId: string, course: CourseDocument) {
    const chapters = Array.isArray(course.chapters) ? course.chapters : [];
    const totalLessons = chapters.reduce(
      (total, chapter) => total + (chapter.content?.length || 0),
      0,
    );
    const practiceCount =
      (Array.isArray(course.quiz) ? course.quiz.length : 0) +
      (Array.isArray(course.flashcards) ? course.flashcards.length : 0) +
      (Array.isArray(course.qa) ? course.qa.length : 0);

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @page { size: A4; margin: 18mm 16mm 20mm; }
      * { box-sizing: border-box; }
      body { margin: 0; color: #111827; font-family: Inter, Arial, sans-serif; line-height: 1.55; }
      .cover { min-height: 245mm; display: flex; flex-direction: column; justify-content: space-between; background: linear-gradient(135deg, #0f172a, #075985); color: white; margin: -18mm -16mm 0; padding: 28mm 20mm; page-break-after: always; }
      .badge { display: inline-block; padding: 6px 10px; border-radius: 999px; background: #22d3ee; color: #083344; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
      h1 { font-size: 46px; line-height: 1.05; margin: 22px 0 16px; letter-spacing: -0.02em; }
      h2 { color: #0f172a; font-size: 25px; line-height: 1.2; margin: 0 0 12px; page-break-after: avoid; }
      h3 { color: #0f172a; font-size: 17px; margin: 24px 0 8px; page-break-after: avoid; }
      p { margin: 0 0 11px; }
      .cover p { color: #dbeafe; max-width: 640px; font-size: 16px; }
      .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 28px; }
      .stat { border: 1px solid rgba(255,255,255,.22); border-radius: 14px; padding: 16px; background: rgba(255,255,255,.09); }
      .stat strong { display:block; font-size: 26px; }
      .stat span { color:#bae6fd; font-size: 12px; text-transform: uppercase; font-weight: 700; }
      .section { page-break-inside: avoid; margin: 0 0 24px; }
      .chapter { border-top: 4px solid #0284c7; padding-top: 16px; margin-top: 12px; page-break-before: always; }
      .lesson { border: 1px solid #e5e7eb; border-radius: 14px; padding: 16px; margin: 14px 0; background: #ffffff; page-break-inside: avoid; }
      .lesson-title { color: #0369a1; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; }
      pre { white-space: pre-wrap; word-break: break-word; background: #18181b; color: #e5e7eb; padding: 14px; border-radius: 10px; font-size: 11px; line-height: 1.45; }
      table { width: 100%; border-collapse: collapse; margin: 12px 0; page-break-inside: avoid; }
      th, td { border: 1px solid #e5e7eb; padding: 10px; text-align: left; vertical-align: top; }
      th { background: #f0f9ff; color: #075985; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
      .muted { color: #64748b; }
      .toc a { color: #0369a1; text-decoration: none; }
    </style>
  </head>
  <body>
    <section class="cover">
      <div>
        <span class="badge">${this.escapeHtml(course.category || 'Course')}</span>
        <h1>${this.escapeHtml(course.courseTitle || 'Untitled course')}</h1>
        <p>${this.escapeHtml(course.description || 'A structured CheFu Academy learning path.')}</p>
        <div class="stats">
          <div class="stat"><strong>${chapters.length}</strong><span>Chapters</span></div>
          <div class="stat"><strong>${totalLessons}</strong><span>Lessons</span></div>
          <div class="stat"><strong>${practiceCount}</strong><span>Practice items</span></div>
        </div>
      </div>
      <div class="muted">Generated by CheFu Academy • ${this.escapeHtml(courseId)}</div>
    </section>

    <section class="section toc">
      <h2>Course Roadmap</h2>
      <table>
        <thead><tr><th>#</th><th>Chapter</th><th>Lessons</th></tr></thead>
        <tbody>
          ${chapters
            .map(
              (chapter, index) => `
          <tr>
            <td>${index + 1}</td>
            <td>${this.escapeHtml(chapter.chapterName || `Chapter ${index + 1}`)}</td>
            <td>${chapter.content?.length || 0}</td>
          </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </section>

    ${chapters
      .map(
        (chapter, chapterIndex) => `
    <section class="chapter">
      <h2>${chapterIndex + 1}. ${this.escapeHtml(chapter.chapterName || `Chapter ${chapterIndex + 1}`)}</h2>
      ${(chapter.content || [])
        .map(
          (item, itemIndex) => `
      <article class="lesson">
        <div class="lesson-title">Lesson ${chapterIndex + 1}.${itemIndex + 1}${item.topic ? ` • ${this.escapeHtml(item.topic)}` : ''}</div>
        ${item.explain ? `<p>${this.escapeHtml(item.explain)}</p>` : ''}
        ${item.example ? `<h3>Example</h3><p>${this.escapeHtml(item.example)}</p>` : ''}
        ${item.code ? `<h3>Code</h3><pre>${this.escapeHtml(this.cleanCode(item.code))}</pre>` : ''}
      </article>`,
        )
        .join('')}
    </section>`,
      )
      .join('')}
  </body>
</html>`;
  }

  private cleanCode(value?: string) {
    return String(value || '')
      .replace(/^```[\w-]*\n/, '')
      .replace(/```$/, '')
      .trim();
  }

  private safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim();
  }

  private escapeHtml(value: unknown) {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };

    return String(value ?? '').replace(/[&<>"']/g, char => map[char]);
  }
}
