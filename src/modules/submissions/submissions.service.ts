import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { Country, State } from 'country-state-city';
import { FieldValue } from 'firebase-admin/firestore';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import isEmail from 'validator/lib/isEmail';
import { RuntimeLimitService } from '../../common/runtime-limit.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { ResendService } from '../email/resend.service';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

const MAX_CV_BYTES = 8 * 1024 * 1024;
const ALLOWED_CV_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const CAREERS_TERMS_VERSION = '2026-10-10';
const CAREERS_PRIVACY_NOTICE_VERSION = '2026-10-10';
const CAREER_ROLES_BY_DEPARTMENT: Record<string, readonly string[]> = {
  'Software Engineering': ['Frontend Developer', 'Backend Developer', 'Intern (Open Application)', 'Other'],
  'Artificial Intelligence': ['Backend Developer', 'Intern (Open Application)', 'Other'],
  'Music Production': [
    'Music Producer',
    'Mixing & Mastering Engineer',
    'Songwriter / Composer',
    'Sound Designer',
    'Intern (Open Application)',
    'Other',
  ],
  'Creative Direction': ['Content Creator', 'UI/UX Designer', 'Intern (Open Application)', 'Other'],
  'Content & Media': ['Content Creator', 'Sound Designer', 'Intern (Open Application)', 'Other'],
  'Marketing & Growth': ['Marketing Specialist', 'Content Creator', 'Intern (Open Application)', 'Other'],
  'Product & Design': ['UI/UX Designer', 'Frontend Developer', 'Intern (Open Application)', 'Other'],
  Security: ['Security Researcher', 'Intern (Open Application)', 'Other'],
};
const COUNTRIES_BY_NAME = new Map(
  Country.getAllCountries().map(country => [country.name, country]),
);
const execFileAsync = promisify(execFile);

@Injectable()
export class SubmissionsService {
  private readonly logger = new Logger(SubmissionsService.name);

  constructor(
    private readonly firebaseAdmin: FirebaseAdminService,
    private readonly resendService: ResendService,
    private readonly runtimeLimits: RuntimeLimitService,
  ) {}

  async submitContact(user: AuthenticatedUser, input: Record<string, unknown>) {
    const data = {
      name: this.requiredString(input.name, 'Name', 120),
      email: this.email(input.email || user.email),
      company: this.string(input.company, 160),
      projectType: this.requiredString(input.projectType, 'Project type', 100),
      budget: this.string(input.budget, 80),
      message: this.requiredString(input.message, 'Message', 5000),
      userId: user.uid,
      userEmail: user.email,
      createdAt: FieldValue.serverTimestamp(),
    };

    const reference = await this.firebaseAdmin.db().collection('contactRequests').add(data);
    this.logger.log(JSON.stringify({ event: 'contact_request_created', requestId: reference.id, uid: user.uid }));
    return { success: true, id: reference.id };
  }

  async submitCareer(input: Record<string, unknown>, clientIp?: string) {
    if (this.string(input.website, 200)) throw new BadRequestException('Submission rejected.');
    if (input.termsAccepted !== true || input.termsVersion !== CAREERS_TERMS_VERSION) {
      throw new BadRequestException('Agreement to the current Terms is required.');
    }
    if (
      input.privacyNoticeAcknowledged !== true ||
      input.privacyNoticeVersion !== CAREERS_PRIVACY_NOTICE_VERSION
    ) {
      throw new BadRequestException('Acknowledgement of the current applicant privacy notice is required.');
    }

    const fullName = this.requiredString(input.fullName, 'Full name', 120);
    const email = this.email(input.email);
    await this.reserveCareerSubmission(clientIp, email);
    const cv = this.parseCv(input);
    if (cv) await this.scanCv(cv.buffer);
    const applicationId = `application_${randomUUID()}`;
    const retentionExpiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
    const record = {
      fullName,
      email,
      phone: this.string(input.phone, 40),
      country: this.country(input.country),
      province: '',
      city: this.requiredString(input.city, 'City', 100),
      department: this.department(input.department),
      roleApplyingFor: '',
      skills: this.requiredString(input.skills, 'Skills', 3000),
      linkedInLink: this.url(input.linkedInLink),
      experienceLevel: this.requiredString(input.experienceLevel, 'Experience level', 40),
      yearsOfExperience: this.requiredString(input.yearsOfExperience, 'Years of experience', 40),
      preferredWorkMode: this.requiredString(input.preferredWorkMode, 'Preferred work mode', 40),
      earliestStartDate: this.requiredString(input.earliestStartDate, 'Earliest start date', 40),
      highestEducation: this.requiredString(input.highestEducation, 'Highest education', 80),
      workAuthorization: this.requiredString(input.workAuthorization, 'Work authorization', 80),
      portfolioLink: this.url(input.portfolioLink),
      musicPortfolioLink: this.url(input.musicPortfolioLink),
      cvFileName: cv?.name || '',
      cvFileSize: cv?.buffer.length || null,
      cvFileUrl: '',
      whyJoin: this.requiredString(input.whyJoin, 'Why join', 5000),
      whatMakesYouDifferent: this.requiredString(input.whatMakesYouDifferent, 'What makes you different', 5000),
      hoursPerWeek: this.requiredString(input.hoursPerWeek, 'Hours per week', 40),
      status: 'submitted',
      confirmationEmailStatus: 'pending',
      internalNotificationStatus: 'pending',
      termsVersion: CAREERS_TERMS_VERSION,
      termsAcceptedAt: FieldValue.serverTimestamp(),
      privacyNoticeVersion: CAREERS_PRIVACY_NOTICE_VERSION,
      privacyNoticeAcknowledgedAt: FieldValue.serverTimestamp(),
      retentionExpiresAt,
      createdAt: FieldValue.serverTimestamp(),
    };
    const province = this.province(input.province, record.country);
    const roleApplyingFor = this.role(input.roleApplyingFor, record.department);
    record.province = province;
    record.roleApplyingFor = roleApplyingFor;

    const reference = this.firebaseAdmin.db().collection('membershipApplications').doc(applicationId);
    await reference.set(record);

    let cvFilePath = '';
    let cvStorageError: string | null = null;
    if (cv) {
      cvFilePath = `membershipApplications/${applicationId}/cv/${Date.now()}_${cv.name}`;
      try {
        const file = this.firebaseAdmin.storageBucket().file(cvFilePath);
        await file.save(cv.buffer, { metadata: { contentType: cv.contentType }, resumable: false });
        const [cvFileUrl] = await file.getSignedUrl({ action: 'read', expires: retentionExpiresAt });
        await reference.update({ cvFileUrl, cvStorageStatus: 'stored' });
        record.cvFileUrl = cvFileUrl;
      } catch (error) {
        cvStorageError = error instanceof Error ? error.message : 'Unknown storage error';
        await reference.update({ cvStorageStatus: 'failed' });
        this.logger.error(
          JSON.stringify({
            event: 'career_cv_storage_failed',
            applicationId,
            reason: cvStorageError,
          }),
        );
      }
    }

    try {
      const emailCvFileUrl = cv && !cvStorageError
        ? (await this.firebaseAdmin.storageBucket()
            .file(cvFilePath)
            .getSignedUrl({
              action: 'read',
              expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
            }))[0]
        : '';
      await this.resendService.sendCareerApplicationNotification({
        applicationId,
        applicant: {
          fullName,
          email,
          phone: record.phone,
          country: record.country,
          province: record.province,
          city: record.city,
          department: record.department,
          roleApplyingFor: record.roleApplyingFor,
          skills: record.skills,
          linkedInLink: record.linkedInLink,
          experienceLevel: record.experienceLevel,
          yearsOfExperience: record.yearsOfExperience,
          preferredWorkMode: record.preferredWorkMode,
          earliestStartDate: record.earliestStartDate,
          highestEducation: record.highestEducation,
          workAuthorization: record.workAuthorization,
          portfolioLink: record.portfolioLink,
          musicPortfolioLink: this.string(input.musicPortfolioLink, 500),
          whyJoin: record.whyJoin,
          whatMakesYouDifferent: record.whatMakesYouDifferent,
          hoursPerWeek: record.hoursPerWeek,
          cvFileName: record.cvFileName,
          cvFileUrl: emailCvFileUrl,
          cvDeliveryMode: cvStorageError
            ? 'Attached to this email because Firebase Storage upload failed.'
            : cv
              ? 'Available through the temporary CV link below.'
              : 'No CV was provided.',
        },
        cvAttachment: cv && cvStorageError
          ? {
              filename: cv.name,
              content: cv.buffer.toString('base64'),
              contentType: cv.contentType,
            }
          : undefined,
      });
      await reference.update({ internalNotificationStatus: 'sent' });
    } catch (error) {
      await reference.update({ internalNotificationStatus: 'failed' });
      this.logger.error(
        JSON.stringify({
          event: 'career_application_notification_failed',
          applicationId,
          reason: error instanceof Error ? error.message : 'Unknown email error',
        }),
      );
    }

    try {
      await this.resendService.sendCareerApplicationConfirmation({
        applicationId,
        email,
        fullName,
        department: record.department,
        roleApplyingFor: record.roleApplyingFor,
      });
      await reference.update({ confirmationEmailStatus: 'sent' });
    } catch (error) {
      await reference.update({ confirmationEmailStatus: 'failed' });
      this.logger.error(
        JSON.stringify({
          event: 'career_application_confirmation_failed',
          applicationId,
          reason: error instanceof Error ? error.message : 'Unknown email error',
        }),
      );
    }

    this.logger.log(JSON.stringify({ event: 'career_application_created', applicationId, email }));
    return { success: true, applicationId };
  }

  private async reserveCareerSubmission(clientIp: string | undefined, email: string) {
    const limits = [
      {
        key: `ip:${clientIp || 'unknown'}`,
        limit: 3,
        windowMs: 60 * 60 * 1000,
      },
      {
        key: `email:${email}`,
        limit: 2,
        windowMs: 24 * 60 * 60 * 1000,
      },
    ];

    for (const limit of limits) {
      const result = await this.runtimeLimits.reserve({
        collection: 'career_submission_limits',
        ...limit,
      });
      if (result.limited) {
        throw new HttpException(
          'Too many applications submitted. Please try again later.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  private country(value: unknown) {
    const country = this.requiredString(value, 'Country', 80);
    if (!COUNTRIES_BY_NAME.has(country)) {
      throw new BadRequestException('Please select a valid country.');
    }
    return country;
  }

  private department(value: unknown) {
    const department = this.requiredString(value, 'Department', 100);
    if (!CAREER_ROLES_BY_DEPARTMENT[department]) {
      throw new BadRequestException('Please select a valid department.');
    }
    return department;
  }

  private role(value: unknown, department: string) {
    const role = this.requiredString(value, 'Role', 120);
    if (!CAREER_ROLES_BY_DEPARTMENT[department]?.includes(role)) {
      throw new BadRequestException('Please select a role that matches the department.');
    }
    return role;
  }

  private province(value: unknown, countryName: string) {
    const province = this.string(value, 100);
    const country = COUNTRIES_BY_NAME.get(countryName);
    const states = country ? State.getStatesOfCountry(country.isoCode) : [];
    if (!states.length) return province;
    if (!province || !states.some(state => state.name === province)) {
      throw new BadRequestException('Please select a valid province or state.');
    }
    return province;
  }

  private parseCv(input: Record<string, unknown>) {
    const raw = this.string(input.cvBase64, MAX_CV_BYTES * 2);
    if (!raw) return null;
    const match = raw.match(/^data:([^;]+);base64,(.+)$/i);
    const contentType = String(match?.[1] || input.cvContentType || '').toLowerCase();
    const base64 = match?.[2] || raw;
    const name = this.safeFileName(input.cvFileName);
    if (!name || !ALLOWED_CV_TYPES.has(contentType) || !/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) throw new BadRequestException('CV must be a valid PDF or Word document.');
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length || buffer.length > MAX_CV_BYTES) throw new BadRequestException('CV must not exceed 8 MB.');
    return { buffer, contentType, name };
  }

  private async scanCv(buffer: Buffer) {
    const scanDirectory = await mkdtemp(join(tmpdir(), 'chefu-cv-scan-'));
    const scanPath = join(scanDirectory, 'upload');

    try {
      await writeFile(scanPath, buffer, { mode: 0o600 });
      await execFileAsync(
        process.env.CLAMSCAN_PATH || '/usr/bin/clamscan',
        ['--no-summary', '--infected', scanPath],
        {
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );
    } catch (error) {
      const processError = error as NodeJS.ErrnoException & { code?: number | string };
      if (String(processError.code) === '1') {
        throw new BadRequestException('The uploaded CV was rejected as potentially unsafe.');
      }

      this.logger.error(
        JSON.stringify({
          event: 'career_cv_scan_unavailable',
          errorCode: processError.code || 'unknown',
        }),
      );
      throw new ServiceUnavailableException(
        'CV scanning is temporarily unavailable. Please try again later.',
      );
    } finally {
      await rm(scanDirectory, { recursive: true, force: true });
    }
  }

  private requiredString(value: unknown, label: string, max: number) { const result = this.string(value, max); if (!result) throw new BadRequestException(`${label} is required.`); return result; }
  private string(value: unknown, max: number) { const result = typeof value === 'string' ? value.trim() : ''; if (result.length > max) throw new BadRequestException('A submitted field is too long.'); return result; }
  private email(value: unknown) { const result = this.string(value, 254).toLowerCase(); if (!isEmail(result)) throw new BadRequestException('A valid email is required.'); return result; }
  private url(value: unknown) { const result = this.string(value, 500); if (!result) return ''; try { const parsed = new URL(result); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); return parsed.toString(); } catch { throw new BadRequestException('Links must be valid HTTP or HTTPS URLs.'); } }
  private safeFileName(value: unknown) { const result = this.string(value, 160).replace(/[^a-zA-Z0-9._-]/g, '_'); return result && !result.startsWith('.') ? result : ''; }
}