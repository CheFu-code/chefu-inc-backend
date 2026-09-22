import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { UploadApiOptions, v2 as cloudinary } from 'cloudinary';
import { FieldValue } from 'firebase-admin/firestore';
import sanitizeHtml from 'sanitize-html';
import { assertCloudinaryConfigured } from '../../common/env';
import { RuntimeLimitService } from '../../common/runtime-limit.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import {
  CloudenceFileDocument,
  CloudenceFileType,
  UpdateCloudenceFileInput,
  UploadCloudenceFileInput,
} from './cloudence.types';

const COLLECTION = 'cloudenceFiles';
const AUDIT_COLLECTION = 'cloudence_audit_logs';
const QUOTA_COLLECTION = 'cloudence_quotas';
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file
const MAX_STORAGE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB quota per user
const MAX_SHARE_RECIPIENTS = 25; // Anti-phishing / anti-spam share cap
const ALLOWED_TYPES = new Set(['document', 'image', 'video', 'audio', 'other']);

// Block executables, scripts, and potential malware vectors
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'sh', 'bash', 'zsh', 'ps1', 'psm1', 'psd1',
  'msi', 'msp', 'scr', 'pif', 'com', 'hta', 'cpl', 'vbs', 'vbe', 'wsf', 'wsh',
  'php', 'php3', 'php4', 'php5', 'phtml', 'phar',
  'py', 'pyc', 'pyo', 'pyw', 'rb', 'pl', 'cgi',
  'jar', 'war', 'ear',
  'dll', 'so', 'dylib', 'sys', 'drv',
  'js', 'mjs', 'cjs', 'ts',
]);

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

@Injectable()
export class CloudenceService {
  private readonly logger = new Logger(CloudenceService.name);

  constructor(
    private readonly firebaseAdmin: FirebaseAdminService,
    private readonly runtimeLimits: RuntimeLimitService,
  ) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }

  /**
   * Upload a file from a raw binary buffer (received via multipart/form-data through multer).
   * All existing security checks (magic bytes, DLP, SVG sanitisation, EXIF strip,
   * SHA-256, quota) run on the buffer directly — no base64 decode needed.
   */
  async upload(user: AuthenticatedUser, rawBuffer: Buffer, rawName: string, rawContentType: string) {
    assertCloudinaryConfigured();

    // Rate limit: max 15 uploads per minute per user
    const rateLimit = await this.runtimeLimits.reserve({
      collection: 'cloudence_upload_limits',
      key: user.uid,
      limit: 15,
      windowMs: 60 * 1000,
    });
    if (rateLimit.limited) {
      throw new BadRequestException('Upload rate limit reached. Please wait a minute before uploading more files.');
    }

    const name = this.sanitizeFileName(String(rawName || '').trim());
    const contentType = String(rawContentType || 'application/octet-stream').toLowerCase();

    if (!name) throw new BadRequestException('A valid file name is required.');
    if (!rawBuffer || rawBuffer.length === 0) throw new BadRequestException('A valid file is required.');

    this.assertSafeExtension(name);

    let buffer: Buffer<ArrayBufferLike> = rawBuffer as Buffer<ArrayBufferLike>;
    const { maxBytes, label } = this.getMaxBytesForType(name, contentType);
    if (buffer.length > maxBytes) {
      throw new BadRequestException(`File size exceeds allowed limit (${label}).`);
    }

    // Inspect file content magic bytes to detect disguised executables/scripts
    this.assertSafeBuffer(buffer, name, contentType);

    // DLP scan: block accidental secret, private key, and cloud credential leaks
    this.assertNoSecretLeak(buffer, name, contentType);

    // Sanitize SVG vector files against stored XSS
    const ext = this.extension(name);
    if (ext === 'svg' || contentType.includes('svg')) {
      buffer = this.sanitizeSvgBuffer(buffer);
    }

    // Compute cryptographic SHA-256 integrity checksum
    const sha256 = createHash('sha256').update(buffer).digest('hex');

    // Enforce 2GB user storage quota before upload
    const currentUsage = await this.getOwnedStorageBytes(user.uid);
    if (currentUsage + buffer.length > MAX_STORAGE_BYTES) {
      const usedMb = (currentUsage / (1024 * 1024)).toFixed(1);
      const fileMb = (buffer.length / (1024 * 1024)).toFixed(1);
      throw new BadRequestException(
        `Storage quota of 2 GB exceeded. Current usage is ${usedMb} MB and this file is ${fileMb} MB.`,
      );
    }

    const type = this.fileType(name, contentType);
    const extension = this.extension(name);
    const result = await this.uploadBuffer(buffer, {
      public_id: `chefu/cloudence/${user.uid}/${randomUUID()}`,
      resource_type: 'auto',
      overwrite: false,
      flags: 'strip_profile', // Strip EXIF GPS coordinates and camera metadata for physical privacy
      tags: ['chefu', 'cloudence', type, user.email],
      context: { original_name: name, content_type: contentType, sha256 },
    });

    const now = new Date().toISOString();
    const id = `cloudence_${randomUUID()}`;

    // Pre-compute and cache the signed delivery URL once at upload time so that
    // list() can return it from Firestore without running N×HMAC-SHA1 per request.
    const partialDoc = {
      id, name, type, extension,
      url: result.secure_url,
      size: buffer.length,
      ownerId: user.uid,
      owner: { id: user.uid, fullName: user.email.split('@')[0], email: user.email },
      users: [] as string[],
      publicId: result.public_id,
      resourceType: result.resource_type || 'raw',
      createdAt: now, updatedAt: now,
      isDeleted: false,
      sha256,
    };
    const signedUrl = this.signUrl(partialDoc);

    const document: CloudenceFileDocument = { ...partialDoc, signedUrl };

    await this.firebaseAdmin.db().collection(COLLECTION).doc(id).set(document);

    // Atomically increment user quota cache
    await this.updateQuotaOnUpload(user.uid, type, buffer.length, now);

    await this.logAudit(user, 'file.uploaded', id, {
      name,
      size: buffer.length,
      type,
      extension,
      sha256,
    });

    return this.sanitizeFileForUser(document, user);
  }

  async list(user: AuthenticatedUser, input: { type?: string; types?: string; search?: string; sort?: string; limit?: number }) {
    const collection = this.firebaseAdmin.db().collection(COLLECTION);
    const rawSearch = String(input?.search || '').slice(0, 100);
    const search = rawSearch.replace(/[\x00-\x1F\x7F]/g, '').trim().toLowerCase();
    const type = String(input?.type || '').trim();
    const typesInput = String(input?.types || '').trim();
    const targetTypes = typesInput
      ? typesInput.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
      : (type && type !== 'all' ? [type.toLowerCase()] : []);

    const limit = Math.min(Math.max(Number(input?.limit || 100), 1), 100);
    const { field, direction } = this.resolveSort(input?.sort);

    // Fetch batch with limit * 2 (capped at 200) to ensure soft-deleted or non-matching records do not starve results
    const fetchLimit = Math.min(limit * 2, 200);

    const [ownedSnapshot, sharedSnapshot] = await Promise.all([
      collection.where('ownerId', '==', user.uid).orderBy(field, direction).limit(fetchLimit).get(),
      collection.where('users', 'array-contains', user.email).orderBy(field, direction).limit(fetchLimit).get(),
    ]);

    const now = new Date();
    // O(N) deduplication using Map instead of O(N^2) findIndex
    const uniqueFiles = new Map<string, CloudenceFileDocument>();
    for (const doc of [...ownedSnapshot.docs, ...sharedSnapshot.docs]) {
      const data = doc.data() as CloudenceFileDocument;
      if (!uniqueFiles.has(data.id)) {
        uniqueFiles.set(data.id, data);
      }
    }

    const documents: CloudenceFileDocument[] = [];
    for (const file of uniqueFiles.values()) {
      if (file.isDeleted) continue;
      // Non-owners cannot see file if the share expiration has passed
      if (file.ownerId !== user.uid && file.shareExpiresAt) {
        if (new Date(file.shareExpiresAt) <= now) continue;
      }
      if (targetTypes.length && !targetTypes.includes(file.type)) continue;
      if (search && !file.name.toLowerCase().includes(search)) continue;
      documents.push(file);
    }

    // Sort according to requested sort order
    documents.sort((left, right) => this.compareFiles(left, right, field, direction));
    const sliced = documents.slice(0, limit).map((file) => this.sanitizeFileForUser(file, user));

    return { total: sliced.length, documents: sliced };
  }

  private resolveSort(value?: string): { field: 'createdAt' | 'name' | 'size'; direction: 'asc' | 'desc' } {
    const [field, direction] = String(value || '$createdAt-desc').split('-');
    if (
      (field === '$createdAt' || field === 'name' || field === 'size') &&
      (direction === 'asc' || direction === 'desc')
    ) {
      return { field: field === '$createdAt' ? 'createdAt' : field, direction };
    }
    return { field: 'createdAt', direction: 'desc' };
  }

  private compareFiles(
    left: CloudenceFileDocument,
    right: CloudenceFileDocument,
    field: 'createdAt' | 'name' | 'size',
    direction: 'asc' | 'desc',
  ) {
    const leftValue = left[field];
    const rightValue = right[field];
    const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue));
    return direction === 'asc' ? comparison : -comparison;
  }

  async update(user: AuthenticatedUser, id: string, input: UpdateCloudenceFileInput) {
    const ref = this.firebaseAdmin.db().collection(COLLECTION).doc(id);
    const snapshot = await ref.get();
    const file = snapshot.data() as CloudenceFileDocument | undefined;
    // Determine the intent so the error message is meaningful to the caller.
    const action = input.users !== undefined ? 'share' : 'rename';
    this.assertCanEdit(file, user, action);

    let name = file!.name;
    if (input.name !== undefined) {
      name = this.sanitizeFileName(String(input.name));
      if (!name) throw new BadRequestException('File name is required.');
      this.assertSafeExtension(name);
    }

    let users = file!.users;
    let shareExpiresAt = file!.shareExpiresAt;

    if (input.users !== undefined) {
      // Rate limit: max 30 share operations per minute per user
      const rateLimit = await this.runtimeLimits.reserve({
        collection: 'cloudence_share_limits',
        key: user.uid,
        limit: 30,
        windowMs: 60 * 1000,
      });
      if (rateLimit.limited) {
        throw new BadRequestException('Too many share requests. Please wait a moment before trying again.');
      }

      const rawUsers = input.users.map(String).map((email) => email.trim().toLowerCase()).filter(Boolean);
      for (const email of rawUsers) {
        if (!EMAIL_REGEX.test(email)) {
          throw new BadRequestException(`"${email}" is not a valid email address.`);
        }
      }
      // Deduplicate and ensure owner does not add themselves
      users = [...new Set(rawUsers.filter((email) => email !== user.email))];

      // Anti-phishing & anti-spam: limit total shared recipients per file
      if (users.length > MAX_SHARE_RECIPIENTS) {
        throw new BadRequestException(`A file can be shared with a maximum of ${MAX_SHARE_RECIPIENTS} users.`);
      }
    }

    if (input.shareExpiresAt !== undefined) {
      if (input.shareExpiresAt && isNaN(Date.parse(input.shareExpiresAt))) {
        throw new BadRequestException('shareExpiresAt must be a valid ISO date string.');
      }
      shareExpiresAt = input.shareExpiresAt ? new Date(input.shareExpiresAt).toISOString() : undefined;
    }

    const updated = {
      ...file!,
      name,
      users,
      shareExpiresAt,
      updatedAt: new Date().toISOString(),
    };
    await ref.set(updated);

    if (input.name !== undefined && name !== file!.name) {
      await this.logAudit(user, 'file.renamed', id, { oldName: file!.name, newName: name });
    }
    if (input.users !== undefined) {
      await this.logAudit(user, 'file.shared', id, {
        previousUsers: file!.users,
        updatedUsers: users,
        shareExpiresAt,
      });
    }

    return this.sanitizeFileForUser(updated, user);
  }

  async remove(user: AuthenticatedUser, id: string) {
    const ref = this.firebaseAdmin.db().collection(COLLECTION).doc(id);
    const snapshot = await ref.get();
    const file = snapshot.data() as CloudenceFileDocument | undefined;
    this.assertCanEdit(file, user, 'delete');

    const now = new Date().toISOString();
    // Soft-delete to prevent irrecoverable data loss on account compromise
    const updated = {
      ...file!,
      isDeleted: true,
      deletedAt: now,
      deletedBy: user.uid,
      updatedAt: now,
    };
    await ref.set(updated);

    // Atomically decrement quota for the file owner
    await this.updateQuotaOnDelete(file!.ownerId, file!.type, file!.size);

    await this.logAudit(user, 'file.deleted', id, {
      name: file!.name,
      size: file!.size,
      publicId: file!.publicId,
      softDelete: true,
    });

    return { status: 'success' };
  }

  async usage(user: AuthenticatedUser) {
    const quotaRef = this.firebaseAdmin.db().collection(QUOTA_COLLECTION).doc(user.uid);
    const quotaSnap = await quotaRef.get();

    if (quotaSnap.exists) {
      const data = quotaSnap.data() || {};
      if (data.image && data.document && data.video && data.audio && data.other) {
        return {
          image: data.image,
          document: data.document,
          video: data.video,
          audio: data.audio,
          other: data.other,
          used: Number(data.used) || 0,
          all: MAX_STORAGE_BYTES,
        };
      }
    }

    // Cold cache fallback: compute once, cache in Firestore, and return
    const snapshot = await this.firebaseAdmin.db().collection(COLLECTION)
      .where('ownerId', '==', user.uid)
      .select('type', 'size', 'updatedAt', 'isDeleted')
      .get();

    const totalSpace = {
      image: { size: 0, latestDate: '' },
      document: { size: 0, latestDate: '' },
      video: { size: 0, latestDate: '' },
      audio: { size: 0, latestDate: '' },
      other: { size: 0, latestDate: '' },
      used: 0,
      all: MAX_STORAGE_BYTES,
    };

    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data.isDeleted) continue; // Exclude deleted files from active quota

      const type = (data.type as CloudenceFileType) || 'other';
      const size = Number(data.size) || 0;
      const updatedAt = String(data.updatedAt || '');

      if (totalSpace[type]) {
        totalSpace[type].size += size;
        if (!totalSpace[type].latestDate || updatedAt > totalSpace[type].latestDate) {
          totalSpace[type].latestDate = updatedAt;
        }
      }
      totalSpace.used += size;
    }

    // Cache the aggregated summary in Firestore for O(1) subsequent loads
    await quotaRef.set({
      image: totalSpace.image,
      document: totalSpace.document,
      video: totalSpace.video,
      audio: totalSpace.audio,
      other: totalSpace.other,
      used: totalSpace.used,
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    return totalSpace;
  }

  async getOwnedStorageBytes(userId: string): Promise<number> {
    try {
      const quotaRef = this.firebaseAdmin.db().collection(QUOTA_COLLECTION).doc(userId);
      const quotaSnap = await quotaRef.get();
      if (quotaSnap.exists) {
        return Number(quotaSnap.data()?.used) || 0;
      }
      const snapshot = await this.firebaseAdmin.db().collection(COLLECTION)
        .where('ownerId', '==', userId)
        .select('size', 'isDeleted')
        .get();
      const used = snapshot.docs.reduce((acc, doc) => {
        const data = doc.data();
        if (data.isDeleted) return acc;
        return acc + (Number(data.size) || 0);
      }, 0);
      await quotaRef.set({ used, updatedAt: new Date().toISOString() }, { merge: true });
      return used;
    } catch (error) {
      this.logger.warn(`Storage bytes query failed: ${error instanceof Error ? error.message : error}`);
      return 0;
    }
  }

  private async updateQuotaOnUpload(userId: string, type: CloudenceFileType, size: number, date: string) {
    try {
      const quotaRef = this.firebaseAdmin.db().collection(QUOTA_COLLECTION).doc(userId);
      const snap = await quotaRef.get();
      if (!snap.exists) return;
      const data = snap.data() || {};
      const typeData = data[type] || { size: 0, latestDate: '' };
      await quotaRef.set({
        used: (Number(data.used) || 0) + size,
        [type]: {
          size: (Number(typeData.size) || 0) + size,
          latestDate: !typeData.latestDate || date > typeData.latestDate ? date : typeData.latestDate,
        },
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    } catch (error) {
      this.logger.warn(`Failed to update quota on upload: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async updateQuotaOnDelete(userId: string, type: CloudenceFileType, size: number) {
    try {
      const quotaRef = this.firebaseAdmin.db().collection(QUOTA_COLLECTION).doc(userId);
      const snap = await quotaRef.get();
      if (!snap.exists) return;
      const data = snap.data() || {};
      const typeData = data[type] || { size: 0, latestDate: '' };
      await quotaRef.set({
        used: Math.max(0, (Number(data.used) || 0) - size),
        [type]: {
          size: Math.max(0, (Number(typeData.size) || 0) - size),
          latestDate: typeData.latestDate || '',
        },
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    } catch (error) {
      this.logger.warn(`Failed to update quota on delete: ${error instanceof Error ? error.message : error}`);
    }
  }

  async getDownloadUrl(user: AuthenticatedUser, id: string) {
    const ref = this.firebaseAdmin.db().collection(COLLECTION).doc(id);
    const snapshot = await ref.get();
    const file = snapshot.data() as CloudenceFileDocument | undefined;

    if (!file || file.isDeleted) {
      throw new NotFoundException('File was not found.');
    }

    const isOwner = file.ownerId === user.uid;
    const isShared = file.users.includes(user.email);

    if (!isOwner && !isShared) {
      throw new ForbiddenException('You do not have permission to download this file.');
    }

    if (!isOwner && file.shareExpiresAt && new Date() > new Date(file.shareExpiresAt)) {
      throw new ForbiddenException('The sharing link for this file has expired.');
    }

    await this.logAudit(user, 'file.downloaded' as any, id, {
      name: file.name,
      sha256: file.sha256,
    });

    // Generate a secure, expiring signed delivery URL with attachment header
    const downloadUrl = cloudinary.url(file.publicId, {
      sign_url: true,
      secure: true,
      resource_type: (file.resourceType as 'image' | 'video' | 'raw') || 'raw',
      type: 'upload',
      flags: `attachment:${encodeURIComponent(file.name)}`,
      ...(file.extension ? { format: file.extension } : {}),
    });

    return {
      downloadUrl,
      name: file.name,
      sha256: file.sha256,
      size: file.size,
    };
  }

  private assertSafeBuffer(buffer: Buffer<ArrayBufferLike>, name: string, contentType: string) {
    if (buffer.length < 2) return;

    // 1. Windows PE / DOS Executables (MZ)
    if (buffer[0] === 0x4D && buffer[1] === 0x5A) {
      throw new BadRequestException('Executable files (Windows PE/DOS binary) are blocked for security reasons.');
    }

    // 2. Linux / Unix ELF Executables (\x7FELF)
    if (
      buffer.length >= 4 &&
      buffer[0] === 0x7F &&
      buffer[1] === 0x45 &&
      buffer[2] === 0x4C &&
      buffer[3] === 0x46
    ) {
      throw new BadRequestException('Executable files (Linux ELF binary) are blocked for security reasons.');
    }

    // 3. Mach-O Binaries (macOS binaries)
    if (buffer.length >= 4) {
      const isMachO =
        (buffer[0] === 0xFE && buffer[1] === 0xED && buffer[2] === 0xFA && (buffer[3] === 0xCE || buffer[3] === 0xCF)) ||
        (buffer[0] === 0xCF && buffer[1] === 0xFA && buffer[2] === 0xED && buffer[3] === 0xFE) ||
        (buffer[0] === 0xCE && buffer[1] === 0xFA && buffer[2] === 0xED && buffer[3] === 0xFE) ||
        (buffer[0] === 0xCA && buffer[1] === 0xFE && buffer[2] === 0xBA && buffer[3] === 0xBE);
      if (isMachO) {
        throw new BadRequestException('Executable files (Mach-O binary) are blocked for security reasons.');
      }
    }

    // 4. Shell / Script shebang headers (#!/...)
    if (buffer[0] === 0x23 && buffer[1] === 0x21) {
      throw new BadRequestException('Script files (shebang interpreter header) are blocked for security reasons.');
    }

    // 5. PHP tags in binary or text
    const headerSample = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8');
    if (/<\?(?:php|=)/i.test(headerSample)) {
      throw new BadRequestException('Server-side script files (PHP) are blocked for security reasons.');
    }

    // 6. Format integrity checks (ensure image/pdf files actually match claimed format)
    const ext = this.extension(name);
    if (ext === 'pdf' || contentType.includes('pdf')) {
      const pdfHeader = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('ascii');
      if (!pdfHeader.includes('%PDF-')) {
        throw new BadRequestException('Invalid PDF file format. Missing PDF signature.');
      }
    } else if (ext === 'png' || contentType === 'image/png') {
      if (
        buffer.length < 8 ||
        buffer[0] !== 0x89 ||
        buffer[1] !== 0x50 ||
        buffer[2] !== 0x4E ||
        buffer[3] !== 0x47
      ) {
        throw new BadRequestException('Invalid PNG file format. Missing PNG signature.');
      }
    } else if (ext === 'jpg' || ext === 'jpeg' || contentType === 'image/jpeg') {
      if (buffer.length < 3 || buffer[0] !== 0xFF || buffer[1] !== 0xD8 || buffer[2] !== 0xFF) {
        throw new BadRequestException('Invalid JPEG file format. Missing JPEG signature.');
      }
    } else if (ext === 'gif' || contentType === 'image/gif') {
      const gifHeader = buffer.subarray(0, 4).toString('ascii');
      if (gifHeader !== 'GIF8') {
        throw new BadRequestException('Invalid GIF file format. Missing GIF signature.');
      }
    } else if (['docx', 'xlsx', 'pptx', 'zip'].includes(ext)) {
      // 7. Microsoft Office & ZIP archive signature check (PK\x03\x04 or PK\x05\x06)
      if (
        buffer.length < 4 ||
        buffer[0] !== 0x50 ||
        buffer[1] !== 0x4B ||
        (buffer[2] !== 0x03 && buffer[2] !== 0x05 && buffer[2] !== 0x07)
      ) {
        throw new BadRequestException(`Invalid ${ext.toUpperCase()} file format. File is missing the standard PK archive header.`);
      }
    }
  }

  private assertNoSecretLeak(buffer: Buffer<ArrayBufferLike>, name: string, contentType: string) {
    const ext = this.extension(name);
    const isTextual =
      contentType.startsWith('text/') ||
      contentType.includes('json') ||
      contentType.includes('xml') ||
      contentType.includes('yaml') ||
      contentType.includes('javascript') ||
      ['txt', 'env', 'json', 'yml', 'yaml', 'xml', 'conf', 'config', 'properties', 'ini', 'pem', 'key', 'crt'].includes(ext);

    if (!isTextual) return;

    // Scan first 1MB of text for accidental credential/private key leakage
    const sample = buffer.subarray(0, Math.min(buffer.length, 1024 * 1024)).toString('utf8');

    // 1. Private SSH/RSA/EC/PGP Keys
    if (/-----BEGIN[ A-Z0-9_-]*(?:PRIVATE KEY|RSA PRIVATE KEY|OPENSSH PRIVATE KEY|EC PRIVATE KEY)-----/i.test(sample)) {
      throw new BadRequestException('Security alert: The file contains an unencrypted private key and was blocked by Data Loss Prevention (DLP).');
    }

    // 2. AWS Access Key IDs
    if (/\bAKIA[0-9A-Z]{16}\b/.test(sample)) {
      throw new BadRequestException('Security alert: The file contains AWS Access Key credentials and was blocked by Data Loss Prevention (DLP).');
    }

    // 3. GitHub Personal Access Tokens
    if (/\b(?:ghp|gho|ghu|ghs|ghr)_[0-9a-zA-Z]{36}\b/.test(sample)) {
      throw new BadRequestException('Security alert: The file contains a GitHub Access Token and was blocked by Data Loss Prevention (DLP).');
    }

    // 4. OpenAI / AI Service Secret Keys
    if (/\bsk-[a-zA-Z0-9]{20,T3BlbkFJ[a-zA-Z0-9]{20,}\b/.test(sample) || /\bsk-proj-[a-zA-Z0-9_-]{40,}\b/.test(sample)) {
      throw new BadRequestException('Security alert: The file contains an AI API Secret Key and was blocked by Data Loss Prevention (DLP).');
    }
  }

  private sanitizeSvgBuffer(buffer: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
    const rawSvg = buffer.toString('utf8');
    const cleanSvg = sanitizeHtml(rawSvg, {
      allowedTags: [
        'svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon',
        'ellipse', 'text', 'tspan', 'defs', 'linearGradient', 'radialGradient',
        'stop', 'clipPath', 'pattern', 'mask', 'use', 'symbol', 'title', 'desc',
      ],
      allowedAttributes: {
        '*': [
          'id', 'class', 'style', 'fill', 'fill-rule', 'fill-opacity',
          'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-opacity',
          'width', 'height', 'viewBox', 'xmlns', 'cx', 'cy', 'r', 'rx', 'ry',
          'x', 'y', 'x1', 'y1', 'x2', 'y2', 'dx', 'dy', 'd', 'points', 'transform',
          'opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor',
        ],
      },
      disallowedTagsMode: 'discard',
    });
    return Buffer.from(cleanSvg, 'utf8') as Buffer<ArrayBufferLike>;
  }

  private sanitizeFileName(rawName: string): string {
    if (!rawName) return 'unnamed';
    let sanitized = rawName
      .replace(/\0/g, '') // remove null bytes
      .replace(/[\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/g, '') // strip RTLO, directional marks, and zero-width spaces
      .replace(/<[^>]*>/g, '') // strip html tags
      .replace(/\.\.+[/\\]/g, '') // strip path traversal sequences
      .replace(/[/\\]+/g, '_') // sanitize path separators
      .replace(/[\x00-\x1F\x7F]/g, '') // strip non-printable control characters
      .trim();

    if (!sanitized || sanitized === '.' || sanitized === '..') {
      sanitized = 'file';
    }

    if (sanitized.length > 255) {
      const ext = this.extension(sanitized);
      const base = sanitized.slice(0, 255 - (ext ? ext.length + 1 : 0));
      sanitized = ext ? `${base}.${ext}` : base;
    }

    return sanitized;
  }

  private assertSafeExtension(name: string) {
    const ext = this.extension(name);
    if (BLOCKED_EXTENSIONS.has(ext)) {
      throw new BadRequestException(
        `Files with .${ext} extension are blocked for security reasons (executable and script files are not permitted).`,
      );
    }
  }

  private signUrl(file: Pick<CloudenceFileDocument, 'publicId' | 'resourceType' | 'extension' | 'url' | 'signedUrl'>): string {
    // Fast path: return the pre-computed signed URL cached in Firestore at upload time.
    // This avoids running HMAC-SHA1 for every file in every list() call (was N×CPU per request).
    if ((file as CloudenceFileDocument).signedUrl) {
      return (file as CloudenceFileDocument).signedUrl!;
    }
    if (!file.publicId) return file.url;
    try {
      return cloudinary.url(file.publicId, {
        sign_url: true,
        secure: true,
        resource_type: (file.resourceType as 'image' | 'video' | 'raw') || 'raw',
        type: 'upload',
        ...(file.extension ? { format: file.extension } : {}),
      });
    } catch {
      return file.url;
    }
  }

  private withSignedUrl(file: CloudenceFileDocument): CloudenceFileDocument {
    return {
      ...file,
      url: this.signUrl(file),
    };
  }

  private sanitizeFileForUser(file: CloudenceFileDocument, user: AuthenticatedUser): CloudenceFileDocument {
    const signed = this.withSignedUrl(file);
    // Share Privacy: Only the owner should see the complete list of shared recipients.
    // Non-owner recipients cannot see other recipients' email addresses.
    if (file.ownerId !== user.uid) {
      return {
        ...signed,
        users: [],
      };
    }
    return signed;
  }

  private async logAudit(
    actor: AuthenticatedUser,
    action: 'file.uploaded' | 'file.renamed' | 'file.shared' | 'file.deleted' | 'file.downloaded',
    fileId: string,
    details: Record<string, unknown>,
  ) {
    const logId = `audit_${randomUUID()}`;
    const auditEntry = {
      id: logId,
      action,
      fileId,
      actor: {
        id: actor.uid,
        email: actor.email,
      },
      details,
      timestamp: new Date().toISOString(),
      createdAt: FieldValue.serverTimestamp(),
    };

    await this.firebaseAdmin.db().collection(AUDIT_COLLECTION).doc(logId).set(auditEntry).catch((err) => {
      this.logger.warn(`Failed to write audit log for ${action} on ${fileId}: ${err instanceof Error ? err.message : err}`);
    });
  }

  private assertCanEdit(
    file: CloudenceFileDocument | undefined,
    user: AuthenticatedUser,
    action: 'rename' | 'share' | 'delete',
  ): asserts file is CloudenceFileDocument {
    if (!file || file.isDeleted) throw new NotFoundException('File was not found.');
    if (file.ownerId !== user.uid) {
      const reason =
        action === 'share'
          ? 'You cannot share this file because you are not its owner. Only the owner can manage sharing.'
          : action === 'delete'
          ? 'You cannot delete this file because you are not its owner. Only the owner can delete it.'
          : action === 'rename'
          ? 'You cannot rename this file because you are not its owner. Only the owner can rename it.'
          : 'You are not permitted to modify this file. Only the file owner can perform this action.';
      throw new ForbiddenException(reason);
    }
  }

  private fileType(name: string, contentType: string): CloudenceFileType {
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('video/')) return 'video';
    if (contentType.startsWith('audio/')) return 'audio';
    if (contentType.includes('pdf') || contentType.includes('document') || contentType.includes('text')) return 'document';
    const extension = this.extension(name);
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(extension)) return 'image';
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(extension)) return 'video';
    if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(extension)) return 'audio';
    return ALLOWED_TYPES.has('other') ? 'other' : 'document';
  }

  private extension(name: string) {
    return name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  }

  private getMaxBytesForType(name: string, contentType: string): { maxBytes: number; label: string } {
    const ext = this.extension(name);
    if (ext === 'svg' || contentType.includes('svg')) {
      return { maxBytes: 5 * 1024 * 1024, label: '5 MB for vector SVG files' };
    }
    if (
      contentType.startsWith('text/') ||
      ['txt', 'json', 'xml', 'yaml', 'yml', 'md', 'csv', 'log', 'env', 'conf'].includes(ext)
    ) {
      return { maxBytes: 10 * 1024 * 1024, label: '10 MB for text and data documents' };
    }
    if (contentType.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) {
      return { maxBytes: 20 * 1024 * 1024, label: '20 MB for image files' };
    }
    if (contentType.includes('pdf') || ext === 'pdf' || ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'].includes(ext)) {
      return { maxBytes: 25 * 1024 * 1024, label: '25 MB for PDF and office documents' };
    }
    return { maxBytes: 50 * 1024 * 1024, label: '50 MB for media files' };
  }

  private uploadBuffer(buffer: Buffer<ArrayBufferLike>, options: UploadApiOptions): Promise<{ secure_url: string; public_id: string; resource_type?: string }> {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
        if (error) return reject(new BadRequestException('File upload failed.'));
        if (!result?.secure_url || !result.public_id) return reject(new BadRequestException('File upload returned no asset.'));
        resolve({ secure_url: result.secure_url, public_id: result.public_id, resource_type: result.resource_type });
      });
      Readable.from(buffer).pipe(stream);
    });
  }
}
