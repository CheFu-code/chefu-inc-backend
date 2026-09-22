import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file
const MAX_STORAGE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB quota per user
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

  async upload(user: AuthenticatedUser, input: UploadCloudenceFileInput) {
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

    const rawName = String(input?.name || '').trim();
    const name = this.sanitizeFileName(rawName);
    const contentType = String(input?.contentType || 'application/octet-stream').toLowerCase();
    const rawBase64 = String(input?.dataBase64 || '');
    const base64 = rawBase64.replace(/^data:[^;]+;base64,/, '');

    if (!name || !base64 || !/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) {
      throw new BadRequestException('A valid file is required.');
    }

    this.assertSafeExtension(name);

    let buffer: Buffer<ArrayBufferLike> = Buffer.from(base64, 'base64');
    if (!buffer.length || buffer.length > MAX_FILE_BYTES) {
      throw new BadRequestException('Files must be between 1 byte and 50 MB.');
    }

    // Inspect file content magic bytes to detect disguised executables/scripts
    this.assertSafeBuffer(buffer, name, contentType);

    // Sanitize SVG vector files against stored XSS
    const ext = this.extension(name);
    if (ext === 'svg' || contentType.includes('svg')) {
      buffer = this.sanitizeSvgBuffer(buffer);
    }

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
      tags: ['chefu', 'cloudence', type, user.email],
      context: { original_name: name, content_type: contentType },
    });

    const now = new Date().toISOString();
    const id = `cloudence_${randomUUID()}`;
    const document: CloudenceFileDocument = {
      id,
      name,
      type,
      extension,
      url: result.secure_url,
      size: buffer.length,
      ownerId: user.uid,
      owner: { id: user.uid, fullName: user.email.split('@')[0], email: user.email },
      users: [],
      publicId: result.public_id,
      resourceType: result.resource_type || 'raw',
      createdAt: now,
      updatedAt: now,
      isDeleted: false,
    };

    await this.firebaseAdmin.db().collection(COLLECTION).doc(id).set(document);

    await this.logAudit(user, 'file.uploaded', id, {
      name,
      size: buffer.length,
      type,
      extension,
    });

    return this.sanitizeFileForUser(document, user);
  }

  async list(user: AuthenticatedUser, input: { type?: string; search?: string; sort?: string; limit?: number }) {
    const collection = this.firebaseAdmin.db().collection(COLLECTION);
    const search = String(input?.search || '').trim().toLowerCase();
    const type = String(input?.type || '').trim();
    const limit = Math.min(Math.max(Number(input?.limit || 100), 1), 100);
    const { field, direction } = this.resolveSort(input?.sort);
    const [ownedSnapshot, sharedSnapshot] = await Promise.all([
      collection.where('ownerId', '==', user.uid).orderBy(field, direction).limit(limit).get(),
      collection.where('users', 'array-contains', user.email).orderBy(field, direction).limit(limit).get(),
    ]);
    const documents = [...ownedSnapshot.docs, ...sharedSnapshot.docs]
      .map((doc) => doc.data() as CloudenceFileDocument)
      .filter((file, index, files) => files.findIndex((candidate) => candidate.id === file.id) === index)
      .filter((file) => !file.isDeleted) // Exclude soft-deleted files
      .filter((file) => !type || type === 'all' || file.type === type)
      .filter((file) => !search || file.name.toLowerCase().includes(search))
      .sort((left, right) => this.compareFiles(left, right, field, direction))
      .slice(0, limit)
      .map((file) => this.sanitizeFileForUser(file, user));

    return { total: documents.length, documents };
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
    }

    const updated = { ...file!, name, users, updatedAt: new Date().toISOString() };
    await ref.set(updated);

    if (input.name !== undefined && name !== file!.name) {
      await this.logAudit(user, 'file.renamed', id, { oldName: file!.name, newName: name });
    }
    if (input.users !== undefined) {
      await this.logAudit(user, 'file.shared', id, {
        previousUsers: file!.users,
        updatedUsers: users,
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

    await this.logAudit(user, 'file.deleted', id, {
      name: file!.name,
      size: file!.size,
      publicId: file!.publicId,
      softDelete: true,
    });

    return { status: 'success' };
  }

  async usage(user: AuthenticatedUser) {
    // Only query owned files so shared files don't consume user's quota.
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

    return totalSpace;
  }

  async getOwnedStorageBytes(userId: string): Promise<number> {
    try {
      const snapshot = await this.firebaseAdmin.db().collection(COLLECTION)
        .where('ownerId', '==', userId)
        .select('size', 'isDeleted')
        .get();
      return snapshot.docs.reduce((acc, doc) => {
        const data = doc.data();
        if (data.isDeleted) return acc;
        return acc + (Number(data.size) || 0);
      }, 0);
    } catch (error) {
      this.logger.warn(`Storage bytes query failed: ${error instanceof Error ? error.message : error}`);
      return 0;
    }
  }

  private assertSafeBuffer(buffer: Buffer, name: string, contentType: string) {
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
    }
  }

  private sanitizeSvgBuffer(buffer: Buffer): Buffer {
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
    return Buffer.from(cleanSvg, 'utf8') as Buffer;
  }

  private sanitizeFileName(rawName: string): string {
    if (!rawName) return 'unnamed';
    let sanitized = rawName
      .replace(/\0/g, '') // remove null bytes
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

  private signUrl(file: Pick<CloudenceFileDocument, 'publicId' | 'resourceType' | 'extension' | 'url'>): string {
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
    action: 'file.uploaded' | 'file.renamed' | 'file.shared' | 'file.deleted',
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
