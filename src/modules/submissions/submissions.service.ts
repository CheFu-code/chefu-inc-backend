import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';

const MAX_CV_BYTES = 8 * 1024 * 1024;
const ALLOWED_CV_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

@Injectable()
export class SubmissionsService {
  private readonly logger = new Logger(SubmissionsService.name);

  constructor(private readonly firebaseAdmin: FirebaseAdminService) {}

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

  async submitCareer(input: Record<string, unknown>) {
    if (this.string(input.website, 200)) throw new BadRequestException('Submission rejected.');
    if (input.acceptTerms !== true) throw new BadRequestException('Consent is required.');

    const fullName = this.requiredString(input.fullName, 'Full name', 120);
    const email = this.email(input.email);
    const cv = this.parseCv(input);
    const applicationId = `application_${randomUUID()}`;
    const retentionExpiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
    const record = {
      fullName,
      email,
      phone: this.string(input.phone, 40),
      country: this.requiredString(input.country, 'Country', 80),
      province: this.string(input.province, 100),
      city: this.requiredString(input.city, 'City', 100),
      department: this.requiredString(input.department, 'Department', 100),
      roleApplyingFor: this.requiredString(input.roleApplyingFor, 'Role', 120),
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
      consentGiven: true,
      consentCapturedAt: FieldValue.serverTimestamp(),
      retentionExpiresAt,
      createdAt: FieldValue.serverTimestamp(),
    };

    const reference = this.firebaseAdmin.db().collection('membershipApplications').doc(applicationId);
    await reference.set(record);

    if (cv) {
      const file = this.firebaseAdmin.storageBucket().file(`membershipApplications/${applicationId}/cv/${Date.now()}_${cv.name}`);
      await file.save(cv.buffer, { metadata: { contentType: cv.contentType }, resumable: false });
      const [cvFileUrl] = await file.getSignedUrl({ action: 'read', expires: retentionExpiresAt });
      await reference.update({ cvFileUrl });
    }

    this.logger.log(JSON.stringify({ event: 'career_application_created', applicationId, email }));
    return { success: true, applicationId };
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

  private requiredString(value: unknown, label: string, max: number) { const result = this.string(value, max); if (!result) throw new BadRequestException(`${label} is required.`); return result; }
  private string(value: unknown, max: number) { const result = typeof value === 'string' ? value.trim() : ''; if (result.length > max) throw new BadRequestException('A submitted field is too long.'); return result; }
  private email(value: unknown) { const result = this.string(value, 254).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new BadRequestException('A valid email is required.'); return result; }
  private url(value: unknown) { const result = this.string(value, 500); if (!result) return ''; try { const parsed = new URL(result); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); return parsed.toString(); } catch { throw new BadRequestException('Links must be valid HTTP or HTTPS URLs.'); } }
  private safeFileName(value: unknown) { const result = this.string(value, 160).replace(/[^a-zA-Z0-9._-]/g, '_'); return result && !result.startsWith('.') ? result : ''; }
}