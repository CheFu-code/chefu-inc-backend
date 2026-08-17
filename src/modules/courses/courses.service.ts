import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

const FREE_DAILY_COURSE_DOWNLOAD_LIMIT = 5;

type CourseDocument = {
  createdBy?: string;
  createdByEmail?: string;
  ownerEmail?: string;
  userEmail?: string;
  enrolledBy?: string;
  enrolledByEmail?: string;
  createdByUid?: string;
  ownerUid?: string;
  userId?: string;
  uid?: string;
  docId?: string;
  enrolled?: boolean;
  originalCourseId?: string;
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
  private activePdfJobs = 0;

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
    this.acquirePdfSlot();

    const { course, userProfile, userRef } = await this.getDownloadableCourse(
      user,
      courseId,
    );

    try {
      await this.reserveFreeCourseDownload(userProfile, userRef, courseId);

      const html = this.renderCourseHtml(courseId, course);
      const { default: puppeteer } = await import('puppeteer');
      const browser = await puppeteer.launch({
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: this.puppeteerArgs(),
        headless: true,
      });

      try {
        const page = await browser.newPage();
        page.setDefaultTimeout(this.pdfTimeoutMs());
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
            '<div style="width:100%;font-size:9px;color:#64748b;padding:0 16mm;display:flex;justify-content:space-between;font-family:Inter,Arial,sans-serif;"><span>CHEFU Academy</span><span class="pageNumber"></span></div>',
        });

        return {
          buffer: Buffer.from(pdf),
          fileName: `${this.safeFileName(String(course.courseTitle || 'course'))}.pdf`,
        };
      } finally {
        await browser.close();
      }
    } finally {
      this.releasePdfSlot();
    }
  }

  private acquirePdfSlot() {
    const maxConcurrent = this.safeNumber(
      process.env.COURSE_PDF_MAX_CONCURRENT,
      2,
      1,
      10,
    );

    if (this.activePdfJobs >= maxConcurrent) {
      throw new HttpException(
        'Course exports are busy. Please try again in a moment.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    this.activePdfJobs += 1;
  }

  private releasePdfSlot() {
    this.activePdfJobs = Math.max(0, this.activePdfJobs - 1);
  }

  private pdfTimeoutMs() {
    return this.safeNumber(
      process.env.COURSE_PDF_TIMEOUT_MS,
      30_000,
      5_000,
      120_000,
    );
  }

  private puppeteerArgs() {
    const baseArgs = ['--disable-setuid-sandbox'];

    return process.env.PUPPETEER_NO_SANDBOX === 'false'
      ? baseArgs
      : ['--no-sandbox', ...baseArgs];
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
    if (!this.canAccessCourse(course, user, courseId)) {
      throw new ForbiddenException('You are not authorized to view this course.');
    }

    return {
      course,
      userProfile: userSnap.data() || {},
      courseRef: courseSnap.ref,
      userRef: userSnap.ref,
    };
  }

  private async reserveFreeCourseDownload(
    userProfile: FirebaseFirestore.DocumentData,
    userRef: FirebaseFirestore.DocumentReference,
    courseId: string,
  ) {
    if (userProfile.member === true) return;

    const today = new Date().toISOString().slice(0, 10);
    const db = this.firebaseAdmin.db();

    await db.runTransaction(async transaction => {
      const userSnap = await transaction.get(userRef);
      const latestProfile = userSnap.data() || userProfile || {};

      if (latestProfile.member === true) return;

      const currentUsage = this.objectValue(latestProfile.courseDownloadQuota);
      const sameDay = String(currentUsage.date || '') === today;
      const downloadedCourseIds = sameDay
        ? this.stringArray(currentUsage.courseIds)
        : [];
      const alreadyDownloaded = downloadedCourseIds.includes(courseId);
      if (alreadyDownloaded) return;

      const currentCount = sameDay
        ? Math.max(
            downloadedCourseIds.length,
            Number(currentUsage.count || 0) || 0,
          )
        : 0;

      if (currentCount >= FREE_DAILY_COURSE_DOWNLOAD_LIMIT) {
        throw new HttpException(
          `Free members can download up to ${FREE_DAILY_COURSE_DOWNLOAD_LIMIT} courses per day. Try again tomorrow or upgrade for unlimited downloads.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      transaction.set(
        userRef,
        {
          courseDownloadQuota: {
            date: today,
            count: currentCount + 1,
            courseIds: Array.from(new Set([...downloadedCourseIds, courseId])),
            updatedAt: FieldValue.serverTimestamp(),
          },
        },
        { merge: true },
      );
    });
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
    const isOwner = this.canAccessCourse(course, user, courseId);
    const isCanonical = !course.enrolled && !course.originalCourseId;

    if (!isOwner && !isCanonical) {
      throw new ForbiddenException('You are not authorized to download this course.');
    }

    return {
      course,
      userProfile: userSnap.data() || {},
      courseRef: courseSnap.ref,
      userRef: userSnap.ref,
    };
  }

  private assertCanOpenChapter(
    course: CourseDocument,
    userProfile: FirebaseFirestore.DocumentData,
    chapterIndex: number,
  ) {
    const completedChapterSet = this.completedChapterSet(course);
    const isCompleted = completedChapterSet.has(chapterIndex.toString());

    if (isCompleted && userProfile.member !== true) {
      throw new ForbiddenException(
        'Chapter completed, subscribe to revisit this chapter.',
      );
    }

    if (this.isCourseFullyCompleted(course, completedChapterSet)) return;

    const nextChapterIndex = this.nextRequiredChapterIndex(
      course,
      completedChapterSet,
    );

    if (chapterIndex !== nextChapterIndex) {
      throw new ForbiddenException(
        'Complete the next chapter before opening this one.',
      );
    }
  }

  private canAccessCourse(
    course: CourseDocument,
    user: AuthenticatedUser,
    courseId: string,
  ) {
    const userEmail = this.normalizeOwner(user.email);
    const userUid = String(user.uid || '').trim();
    const emailFields = [
      course.createdBy,
      course.createdByEmail,
      course.ownerEmail,
      course.userEmail,
      course.enrolledBy,
      course.enrolledByEmail,
    ];
    const uidFields = [
      course.createdBy,
      course.createdByUid,
      course.ownerUid,
      course.userId,
      course.uid,
    ];

    if (
      userEmail &&
      emailFields.some(value => this.normalizeOwner(value) === userEmail)
    ) {
      return true;
    }

    if (userUid && uidFields.some(value => String(value || '').trim() === userUid)) {
      return true;
    }

    const ownerPrefix = userEmail.replace(/[@.]/g, '_');
    const docIds = [courseId, course.docId].filter(Boolean).map(String);

    return (
      Boolean(course.enrolled) &&
      Boolean(ownerPrefix) &&
      docIds.some(docId =>
        docId.toLowerCase().startsWith(`${ownerPrefix}_`),
      )
    );
  }

  private normalizeOwner(value?: string) {
    return String(value || '').trim().toLowerCase();
  }

  private objectValue(value: unknown) {
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : {};
  }

  private stringArray(value: unknown) {
    return Array.isArray(value) ? value.map(item => String(item)) : [];
  }

  private completedChapterSet(course: CourseDocument) {
    return new Set(
      Array.isArray(course.completedChapter)
        ? course.completedChapter.map(String)
        : [],
    );
  }

  private isCourseFullyCompleted(
    course: CourseDocument,
    completedChapterSet = this.completedChapterSet(course),
  ) {
    const totalChapters = course.chapters?.length || 0;
    if (totalChapters <= 0) return false;

    return course.chapters!.every((_, index) =>
      completedChapterSet.has(index.toString()),
    );
  }

  private nextRequiredChapterIndex(
    course: CourseDocument,
    completedChapterSet = this.completedChapterSet(course),
  ) {
    const chapters = course.chapters || [];
    if (!chapters.length) return -1;

    const nextIndex = chapters.findIndex((_, index) => {
      return !completedChapterSet.has(index.toString());
    });

    return nextIndex === -1 ? chapters.length - 1 : nextIndex;
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
    const studySessions = Math.max(1, Math.ceil(totalLessons / 4));
    const flashcards = Array.isArray(course.flashcards)
      ? (course.flashcards as Array<{ front?: string; back?: string }>)
      : [];
    const qa = Array.isArray(course.qa)
      ? (course.qa as Array<{ question?: string; answer?: string }>)
      : [];
    const quiz = Array.isArray(course.quiz)
      ? (course.quiz as Array<{ question?: string; correctAns?: string }>)
      : [];

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @page { size: A4; margin: 18mm 16mm 20mm; }
      * { box-sizing: border-box; }
      body { margin: 0; color: #172033; font-family: Inter, Aptos, Arial, sans-serif; font-size: 12.5px; line-height: 1.62; }
      .cover { min-height: 245mm; position: relative; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between; background: #07111f; color: white; margin: -18mm -16mm 0; padding: 24mm 21mm 20mm; page-break-after: always; }
      .cover::before { content: ""; position: absolute; inset: 0; background: radial-gradient(circle at 78% 16%, rgba(14, 165, 233, .52), transparent 24%), radial-gradient(circle at 18% 86%, rgba(20, 184, 166, .38), transparent 28%), linear-gradient(135deg, #07111f 0%, #10233d 48%, #075985 100%); }
      .cover::after { content: ""; position: absolute; right: -34mm; top: 26mm; width: 118mm; height: 178mm; border: 1px solid rgba(255,255,255,.16); border-radius: 38mm; transform: rotate(18deg); background: rgba(255,255,255,.05); }
      .cover > * { position: relative; z-index: 1; }
      .cover-card { margin-top: 18mm; max-width: 154mm; padding: 18mm 16mm; border: 1px solid rgba(255,255,255,.18); border-radius: 24px; background: rgba(255,255,255,.1); box-shadow: 0 28px 70px rgba(0,0,0,.24); }
      .brand-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
      .brand { font-weight: 900; letter-spacing: .08em; text-transform: uppercase; font-size: 12px; color: #e0f2fe; }
      .cover-copy { margin-top: 0; }
      .badge { display: inline-block; padding: 7px 12px; border-radius: 999px; background: #ffffff; color: #0f172a; font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: .08em; }
      .cover-kicker { color: #7dd3fc; font-size: 11px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; margin-bottom: 10px; }
      h1 { font-size: 48px; line-height: 1.02; margin: 0 0 16px; max-width: 760px; }
      h2 { color: #0f172a; font-size: 25px; line-height: 1.2; margin: 0 0 12px; page-break-after: avoid; }
      h3 { color: #0f172a; font-size: 17px; margin: 24px 0 8px; page-break-after: avoid; }
      p { margin: 0 0 11px; }
      .cover p { color: #dbeafe; max-width: 690px; font-size: 16px; }
      .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 24px; }
      .stat { border: 1px solid rgba(255,255,255,.22); border-radius: 16px; padding: 15px 14px; background: rgba(255,255,255,.1); }
      .stat strong { display:block; font-size: 25px; line-height: 1; margin-bottom: 8px; }
      .stat span { color:#bae6fd; font-size: 10px; text-transform: uppercase; font-weight: 800; letter-spacing: .06em; }
      .cover-footer { display: flex; align-items: end; justify-content: space-between; gap: 24px; color: #cbd5e1; font-size: 11px; }
      .cover-footer strong { display: block; color: #ffffff; font-size: 13px; margin-bottom: 4px; }
      .cover-strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 14mm; }
      .cover-strip div { border-top: 1px solid rgba(255,255,255,.22); padding-top: 10px; color: #dbeafe; font-size: 11px; }
      .cover-strip strong { display: block; color: #ffffff; font-size: 13px; margin-bottom: 3px; }
      .section { margin: 0 0 24px; }
      .intro-grid { display: grid; grid-template-columns: 1.15fr .85fr; gap: 14px; align-items: stretch; }
      .panel { border: 1px solid #dbe3ee; border-radius: 16px; background: #f8fafc; padding: 16px; page-break-inside: avoid; }
      .panel-title { color: #0f172a; font-size: 11px; font-weight: 900; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 8px; }
      .checklist { margin: 0; padding: 0; list-style: none; }
      .checklist li { position: relative; padding-left: 24px; margin: 8px 0; }
      .checklist li::before { content: ""; width: 12px; height: 12px; border: 2px solid #0ea5e9; border-radius: 4px; position: absolute; left: 0; top: 4px; }
      .eyebrow { color: #0ea5e9; font-weight: 900; text-transform: uppercase; letter-spacing: .08em; font-size: 10px; margin-bottom: 5px; }
      .chapter { page-break-before: always; padding-top: 0; }
      .chapter-hero { margin: -18mm -16mm 14mm; padding: 21mm 17mm 17mm; color: #ffffff; background: linear-gradient(135deg, #0f172a, #0369a1); }
      .chapter-number { color: #bae6fd; font-size: 12px; text-transform: uppercase; letter-spacing: .12em; font-weight: 900; }
      .chapter-hero h2 { color: #ffffff; font-size: 32px; margin-top: 8px; max-width: 700px; }
      .lesson { border: 1px solid #dbe3ee; border-radius: 16px; padding: 15px 16px; margin: 12px 0; background: #ffffff; page-break-inside: avoid; box-shadow: 0 8px 18px rgba(15, 23, 42, .04); }
      .lesson-title { color: #0ea5e9; font-size: 10px; font-weight: 900; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px; }
      .topic { font-size: 16px; font-weight: 800; color: #0f172a; margin-bottom: 8px; }
      .example { border-left: 4px solid #14b8a6; background: #f0fdfa; border-radius: 10px; padding: 12px 13px; margin-top: 12px; }
      pre { white-space: pre-wrap; word-break: break-word; background: #111827; color: #e5e7eb; padding: 14px; border-radius: 12px; font-size: 10.5px; line-height: 1.48; }
      table { width: 100%; border-collapse: separate; border-spacing: 0; margin: 12px 0; page-break-inside: avoid; overflow: hidden; border: 1px solid #dbe3ee; border-radius: 14px; }
      th, td { border-bottom: 1px solid #dbe3ee; padding: 10px 11px; text-align: left; vertical-align: top; }
      tr:last-child td { border-bottom: 0; }
      th { background: #e0f2fe; color: #075985; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
      tbody tr:nth-child(even) td { background: #f8fafc; }
      .practice { page-break-before: always; }
      .practice-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
      .practice-card { border: 1px solid #dbe3ee; border-radius: 14px; padding: 12px; page-break-inside: avoid; }
      .muted { color: #64748b; }
      .toc a { color: #0369a1; text-decoration: none; }
    </style>
  </head>
  <body>
    <section class="cover">
      <div>
        <div class="brand-row">
          <div class="brand">CHEFU Academy</div>
          <span class="badge">${this.escapeHtml(course.category || 'Course')}</span>
        </div>
        <div class="cover-card">
          <div class="cover-copy">
            <div class="cover-kicker">Premium learning pack</div>
            <h1>${this.escapeHtml(course.courseTitle || 'Untitled course')}</h1>
            <p>${this.escapeHtml(course.description || 'A structured CHEFU Academy learning path.')}</p>
          </div>
          <div class="cover-strip">
            <div><strong>Read</strong>Clear lessons organized into focused chapters.</div>
            <div><strong>Practice</strong>Flashcards, Q&A, and quiz prompts for recall.</div>
            <div><strong>Review</strong>A workbook layout built for offline study.</div>
          </div>
        </div>
        <div class="stats">
          <div class="stat"><strong>${chapters.length}</strong><span>Chapters</span></div>
          <div class="stat"><strong>${totalLessons}</strong><span>Lessons</span></div>
          <div class="stat"><strong>${practiceCount}</strong><span>Practice items</span></div>
          <div class="stat"><strong>${studySessions}</strong><span>Study sessions</span></div>
        </div>
      </div>
      <div class="cover-footer">
        <div><strong>Professional course workbook</strong>Designed for focused reading, practice, and offline revision.</div>
        <div>Course ID: ${this.escapeHtml(courseId)}</div>
      </div>
    </section>

    <section class="section">
      <div class="eyebrow">Start here</div>
      <h2>How to Use This Workbook</h2>
      <div class="intro-grid">
        <div class="panel">
          <div class="panel-title">Study flow</div>
          <p>Read each lesson, pause on the example, then test yourself with the practice material before moving to the next chapter.</p>
          <p class="muted">For best results, complete one chapter per study session and write a short summary in your own words.</p>
        </div>
        <div class="panel">
          <div class="panel-title">Completion checklist</div>
          <ul class="checklist">
            <li>I can explain the core idea without notes.</li>
            <li>I reviewed every example and code block.</li>
            <li>I completed the practice prompts.</li>
            <li>I know what to revisit next.</li>
          </ul>
        </div>
      </div>
    </section>

    <section class="section toc">
      <div class="eyebrow">Roadmap</div>
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
      <div class="chapter-hero">
        <div class="chapter-number">Chapter ${chapterIndex + 1}</div>
        <h2>${this.escapeHtml(chapter.chapterName || `Chapter ${chapterIndex + 1}`)}</h2>
      </div>
      ${(chapter.content || [])
        .map(
          (item, itemIndex) => `
      <article class="lesson">
        <div class="lesson-title">Lesson ${chapterIndex + 1}.${itemIndex + 1}${item.topic ? ` - ${this.escapeHtml(item.topic)}` : ''}</div>
        ${item.explain ? `<p>${this.formatHtmlText(item.explain)}</p>` : ''}
        ${item.example ? `<div class="example"><h3>Worked Example</h3><p>${this.formatHtmlText(item.example)}</p></div>` : ''}
        ${item.code ? `<h3>Code Reference</h3><pre>${this.escapeHtml(this.cleanCode(item.code))}</pre>` : ''}
      </article>`,
        )
        .join('')}
    </section>`,
      )
      .join('')}
    ${
      practiceCount
        ? `<section class="practice">
      <div class="eyebrow">Practice pack</div>
      <h2>Review and Recall</h2>
      ${
        flashcards.length
          ? `<h3>Flashcards</h3><div class="practice-grid">${flashcards
              .slice(0, 20)
              .map(
                (card, index) =>
                  `<div class="practice-card"><div class="lesson-title">Card ${index + 1}</div><p><strong>${this.escapeHtml(card.front || '')}</strong></p><p class="muted">${this.escapeHtml(card.back || '')}</p></div>`,
              )
              .join('')}</div>`
          : ''
      }
      ${
        qa.length
          ? `<h3>Questions and Answers</h3><table><thead><tr><th>#</th><th>Question</th><th>Answer</th></tr></thead><tbody>${qa
              .slice(0, 30)
              .map(
                (item, index) =>
                  `<tr><td>${index + 1}</td><td>${this.escapeHtml(item.question || '')}</td><td>${this.escapeHtml(item.answer || '')}</td></tr>`,
              )
              .join('')}</tbody></table>`
          : ''
      }
      ${
        quiz.length
          ? `<h3>Quiz</h3><table><thead><tr><th>#</th><th>Question</th><th>Answer</th></tr></thead><tbody>${quiz
              .slice(0, 30)
              .map(
                (item, index) =>
                  `<tr><td>${index + 1}</td><td>${this.escapeHtml(item.question || '')}</td><td>${this.escapeHtml(item.correctAns || '')}</td></tr>`,
              )
              .join('')}</tbody></table>`
          : ''
      }
    </section>`
        : ''
    }
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

  private safeNumber(
    value: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
  ) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;

    return Math.min(Math.max(Math.floor(parsed), minimum), maximum);
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

  private formatHtmlText(value: unknown) {
    return this.escapeHtml(value)
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br />');
  }
}

