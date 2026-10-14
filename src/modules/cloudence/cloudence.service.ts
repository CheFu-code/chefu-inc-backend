import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';
import { FieldValue, Transaction } from 'firebase-admin/firestore';
import { createHash, randomUUID } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { CloudinaryStorageService } from '../../common/cloudinary-storage.service';
import { assertCloudinaryConfigured } from '../../common/env';
import { RuntimeLimitService } from '../../common/runtime-limit.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import {
  CloudenceFileDocument,
  CloudenceFileResponse,
  CloudenceFileType,
  UpdateCloudenceFileInput
} from './cloudence.types';
import { ALLOWED_TYPES, AUDIT_COLLECTION, BLOCKED_EXTENSIONS, COLLECTION, EMAIL_REGEX, MAX_SHARE_RECIPIENTS, MAX_STORAGE_BYTES, QUOTA_COLLECTION } from './cloudence.constants';

type StorageQuota = Record<CloudenceFileType, { size: number; latestDate: string }> & { used: number };


@Injectable()
export class CloudenceService {
  private readonly logger = new Logger(CloudenceService.name);
  private readonly quotaCache = new Map<string, { data: Record<string, any>; expiresAt: number }>();
  private readonly quotaLoads = new Map<string, Promise<StorageQuota>>();
  private readonly ownerNames = new Map<string, { name: string; expiresAt: number }>();
  private getCachedQuota(userId: string): Record<string, any> | null {
    const entry = this.quotaCache.get(userId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.quotaCache.delete(userId);
      return null;
    }
    return entry.data;
  }

  private setCachedQuota(userId: string, data: Record<string, any>, ttlMs = 30_000) {
    if (this.quotaCache.size > 5000) {
      const oldestKey = this.quotaCache.keys().next().value;
      if (oldestKey) this.quotaCache.delete(oldestKey);
    }
    this.quotaCache.set(userId, { data, expiresAt: Date.now() + ttlMs });
  }

  private invalidateQuotaCache(userId: string) {
    this.quotaCache.delete(userId);
  }

  constructor(
    private readonly firebaseAdmin: FirebaseAdminService,
    private readonly runtimeLimits: RuntimeLimitService,
    private readonly cloudinaryStorage: CloudinaryStorageService,
  ) {
  }

  /**
   * Upload a file from a raw binary buffer (received via multipart/form-data through multer).
   * All existing security checks (magic bytes, DLP, SVG sanitisation, EXIF strip,
   * SHA-256, quota) run on the buffer directly — no base64 decode needed.
   */
  async upload(user: AuthenticatedUser, rawBuffer: Buffer, rawName: string, rawContentType: string) {
    assertCloudinaryConfigured();

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
    let currentUsage = await this.getOwnedStorageBytes(user.uid);
    // A stale display cache must not reject an upload after another instance frees space.
    if (currentUsage + buffer.length > MAX_STORAGE_BYTES) currentUsage = (await this.loadQuota(user.uid)).used;
    if (currentUsage + buffer.length > MAX_STORAGE_BYTES) {
      const usedMb = (currentUsage / (1024 * 1024)).toFixed(1);
      const fileMb = (buffer.length / (1024 * 1024)).toFixed(1);
      throw new BadRequestException(
        `Storage quota of 2 GB exceeded. Current usage is ${usedMb} MB and this file is ${fileMb} MB.`,
      );
    }

    const type = this.fileType(name, contentType);
    const extension = this.extension(name);
    const result = await this.cloudinaryStorage.uploadBuffer(buffer, {
      public_id: `chefu/cloudence/${user.uid}/${randomUUID()}`,
      resource_type: 'auto',
      type: 'authenticated',
      overwrite: false,
      flags: 'strip_profile', // Strip EXIF GPS coordinates and camera metadata for physical privacy
      tags: ['chefu', 'cloudence', type, user.email],
      context: { original_name: name, content_type: contentType, sha256 },
    });

    const now = new Date().toISOString();
    const id = `cloudence_${randomUUID()}`;
    const [ownerDetails] = await this.withOwnerProfiles([{
      ownerId: user.uid,
      owner: { id: user.uid, fullName: '', email: user.email },
    }]);

    // Storage details remain internal; API responses use the authorized content endpoint.
    const partialDoc = {
      id, name, type, extension,
      url: result.secure_url,
      size: buffer.length,
      ownerId: user.uid,
      owner: ownerDetails.owner,
      users: [] as string[],
      publicId: result.public_id,
      resourceType: result.resource_type || 'raw',
      deliveryType: 'authenticated' as const,
      createdAt: now, updatedAt: now,
      isDeleted: false,
      sha256,
    };
    const document: CloudenceFileDocument = partialDoc;

    const db = this.firebaseAdmin.db();
    try {
      const committedQuota = await db.runTransaction(async (transaction) => {
        const quota = await this.readQuota(transaction, user.uid);
        if (quota.used + document.size > MAX_STORAGE_BYTES) {
          throw new BadRequestException('Storage quota of 2 GB exceeded.');
        }
        quota.used += document.size;
        quota[type] = { size: quota[type].size + document.size, latestDate: now > quota[type].latestDate ? now : quota[type].latestDate };
        transaction.set(db.collection(COLLECTION).doc(id), document);
        transaction.set(db.collection(QUOTA_COLLECTION).doc(user.uid), { ...quota, updatedAt: now });
        return quota;
      });
      this.setCachedQuota(user.uid, { ...committedQuota, all: MAX_STORAGE_BYTES });
    } catch (error) {
      // A rejected commit must not leave an uploaded asset outside the file ledger.
      await this.cloudinaryStorage.delete(result.public_id, (result.resource_type || 'raw') as 'image' | 'video' | 'raw', 'authenticated')
        .catch((cleanupError) => this.logger.error(`Upload cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`));
      throw error;
    }

    // Fire-and-forget: audit log is observability data, not transactional.
    // Awaiting it was adding 50–200 ms to every upload response.
    void this.logAudit(user, 'file.uploaded', id, {
      name, size: buffer.length, type, extension, sha256,
    }).catch((err) => this.logger.warn(`Audit log (file.uploaded) failed: ${err instanceof Error ? err.message : err}`));

    return this.toResponse(this.sanitizeFileForUser(document, user), user);
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

    const userEmail = (user.email || '').toLowerCase().trim();

    // Fetch batch with limit * 2 (capped at 200) to ensure soft-deleted or non-matching records do not starve results
    const fetchLimit = Math.min(limit * 2, 200);

    // Query owned files with fallback if composite index is pending
    const ownedPromise = collection
      .where('ownerId', '==', user.uid)
      .where('isDeleted', '==', false)
      .orderBy(field, direction)
      .limit(fetchLimit)
      .get()
      .catch((err) => {
        this.logger.warn(`Indexed owned query failed (falling back to simple query): ${err instanceof Error ? err.message : err}`);
        return collection
          .where('ownerId', '==', user.uid)
          .limit(fetchLimit)
          .get();
      });

    // Query shared files: normalize email to lowercase, with graceful fallback to standard single-field
    // array-contains index if the multi-field composite index (users + isDeleted + order) is not built in Firestore.
    const sharedPromise = collection
      .where('users', 'array-contains', userEmail)
      .where('isDeleted', '==', false)
      .orderBy(field, direction)
      .limit(fetchLimit)
      .get()
      .catch((err) => {
        this.logger.warn(`Indexed shared query failed (falling back to standard index): ${err instanceof Error ? err.message : err}`);
        return collection
          .where('users', 'array-contains', userEmail)
          .limit(fetchLimit)
          .get();
      });

    const [ownedSnapshot, sharedSnapshot] = await Promise.all([ownedPromise, sharedPromise]);

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
      if (file.isDeleted) continue; // Safety guard if fallback query was used
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
    const filesWithOwners = await this.withOwnerProfiles(documents.slice(0, limit));
    const sliced = filesWithOwners.map((file) => this.toResponse(this.sanitizeFileForUser(file, user), user));

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
    const changesRecipients = input.users !== undefined || input.addUsers !== undefined || input.removeUsers !== undefined;
    const action = changesRecipients || input.shareExpiresAt !== undefined ? 'share' : 'rename';
    if (input.users !== undefined && (input.addUsers !== undefined || input.removeUsers !== undefined)) {
      throw new BadRequestException('Use either a complete recipient list or recipient additions/removals.');
    }
    this.assertCanEdit(file, user, action);

    let name = file!.name;
    if (input.name !== undefined) {
      name = this.sanitizeFileName(String(input.name));
      if (!name) throw new BadRequestException('File name is required.');
      this.assertSafeExtension(name);
      if (this.extension(name) !== file!.extension) {
        throw new BadRequestException('Renaming a file cannot change its format. Keep the original file extension.');
      }
    }

    let users = file!.users;
    let shareExpiresAt = file!.shareExpiresAt;

    const normalizeRecipients = (value: unknown): string[] => {
      if (!Array.isArray(value)) throw new BadRequestException('Recipients must be a list of email addresses.');
      const emails = value.map(String).map((email) => email.trim().toLowerCase()).filter(Boolean);
      for (const email of emails) if (!EMAIL_REGEX.test(email)) throw new BadRequestException(`"${email}" is not a valid email address.`);
      return [...new Set(emails.filter((email) => email !== user.email.trim().toLowerCase()))];
    };
    const additions = input.addUsers !== undefined ? normalizeRecipients(input.addUsers) : [];
    const removals = input.removeUsers !== undefined ? normalizeRecipients(input.removeUsers) : [];
    if (changesRecipients) {
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

      if (input.users !== undefined) users = normalizeRecipients(input.users);

    }

    if (input.shareExpiresAt !== undefined) {
      if (input.shareExpiresAt && isNaN(Date.parse(input.shareExpiresAt))) {
        throw new BadRequestException('shareExpiresAt must be a valid ISO date string.');
      }
      shareExpiresAt = input.shareExpiresAt ? new Date(input.shareExpiresAt).toISOString() : undefined;
      if (shareExpiresAt && Date.parse(shareExpiresAt) <= Date.now()) {
        throw new BadRequestException('Sharing expiration must be in the future.');
      }
    }

    const [updated] = await this.withOwnerProfiles([{
      ...file!,
      name,
      users,
      shareExpiresAt,
      updatedAt: new Date().toISOString(),
    }]);
    const saved = await this.firebaseAdmin.db().runTransaction(async (transaction) => {
      const current = (await transaction.get(ref)).data() as CloudenceFileDocument | undefined;
      this.assertCanEdit(current, user, action);
      const nextUsers = input.users !== undefined ? users : [...new Set([...current!.users, ...additions])].filter((email) => !removals.includes(email));
      if (changesRecipients && nextUsers.length > MAX_SHARE_RECIPIENTS) {
        throw new BadRequestException(`A file can be shared with a maximum of ${MAX_SHARE_RECIPIENTS} users.`);
      }
      const next = {
        ...current!,
        owner: updated.owner,
        ...(input.name !== undefined ? { name } : {}),
        ...(changesRecipients ? { users: nextUsers } : {}),
        ...(input.shareExpiresAt !== undefined ? { shareExpiresAt: shareExpiresAt || FieldValue.delete() } : {}),
        updatedAt: updated.updatedAt,
      };
      transaction.set(ref, next);
      return { ...next, shareExpiresAt: input.shareExpiresAt !== undefined ? shareExpiresAt : current!.shareExpiresAt } as CloudenceFileDocument;
    });

    // Fire-and-forget audit writes — observability only, not transactional
    if (input.name !== undefined && name !== file!.name) {
      void this.logAudit(user, 'file.renamed', id, { oldName: file!.name, newName: name })
        .catch((err) => this.logger.warn(`Audit log (file.renamed) failed: ${err instanceof Error ? err.message : err}`));
    }
    if (changesRecipients) {
      void this.logAudit(user, 'file.shared', id, { previousUsers: file!.users, updatedUsers: saved.users, shareExpiresAt })
        .catch((err) => this.logger.warn(`Audit log (file.shared) failed: ${err instanceof Error ? err.message : err}`));
    }

    return this.toResponse(this.sanitizeFileForUser(saved, user), user);
  }

  async remove(user: AuthenticatedUser, id: string) {
    const ref = this.firebaseAdmin.db().collection(COLLECTION).doc(id);
    const file = await this.firebaseAdmin.db().runTransaction(async (transaction) => {
      const current = (await transaction.get(ref)).data() as CloudenceFileDocument | undefined;
      this.assertCanEdit(current, user, 'delete');
      const quota = await this.readQuota(transaction, current.ownerId);
      const now = new Date().toISOString();
      quota.used = Math.max(0, quota.used - current.size);
      quota[current.type] = { ...quota[current.type], size: Math.max(0, quota[current.type].size - current.size) };
      transaction.set(ref, { ...current, isDeleted: true, deletedAt: now, deletedBy: user.uid, updatedAt: now });
      transaction.set(this.firebaseAdmin.db().collection(QUOTA_COLLECTION).doc(current.ownerId), { ...quota, updatedAt: now });
      return current;
    });
    this.invalidateQuotaCache(file.ownerId);

    // Fire-and-forget audit — observability, not transactional
    void this.logAudit(user, 'file.deleted', id, {
      name: file!.name, size: file!.size, publicId: file!.publicId, softDelete: true,
    }).catch((err) => this.logger.warn(`Audit log (file.deleted) failed: ${err instanceof Error ? err.message : err}`));

    return { status: 'success' };
  }

  private async readQuota(transaction: Transaction, userId: string, initialize = false): Promise<StorageQuota> {
    const db = this.firebaseAdmin.db();
    const snapshot = await transaction.get(db.collection(QUOTA_COLLECTION).doc(userId));
    const data = snapshot.data();
    const types: CloudenceFileType[] = ['image', 'document', 'video', 'audio', 'other'];
    if (data && Number.isFinite(data.used) && data.used >= 0 && types.every((type) => Number.isFinite(data[type]?.size) && data[type].size >= 0)) {
      return {
        used: data.used,
        ...Object.fromEntries(types.map((type) => [type, { size: data[type].size, latestDate: String(data[type].latestDate || '') }])),
      } as StorageQuota;
    }

    // Initialize legacy or missing summaries inside the same transaction as the mutation.
    const files = await transaction.get(db.collection(COLLECTION).where('ownerId', '==', userId));
    const quota: StorageQuota = {
      image: { size: 0, latestDate: '' }, document: { size: 0, latestDate: '' },
      video: { size: 0, latestDate: '' }, audio: { size: 0, latestDate: '' },
      other: { size: 0, latestDate: '' }, used: 0,
    };
    for (const file of files.docs) {
      const value = file.data() as CloudenceFileDocument;
      if (value.isDeleted) continue;
      const type = types.includes(value.type) ? value.type : 'other';
      const size = Math.max(0, Number(value.size) || 0);
      quota.used += size;
      quota[type].size += size;
      if (value.updatedAt > quota[type].latestDate) quota[type].latestDate = value.updatedAt;
    }
    if (initialize) transaction.set(db.collection(QUOTA_COLLECTION).doc(userId), { ...quota, updatedAt: new Date().toISOString() });
    return quota;
  }

  private async loadQuota(userId: string): Promise<StorageQuota> {
    const existing = this.quotaLoads.get(userId);
    if (existing) return existing;
    const db = this.firebaseAdmin.db();
    const pending = db.runTransaction((transaction) => this.readQuota(transaction, userId, true))
      .finally(() => this.quotaLoads.delete(userId));
    this.quotaLoads.set(userId, pending);
    return pending;
  }

  async usage(user: AuthenticatedUser) {
    const cached = this.getCachedQuota(user.uid);
    if (cached) return cached;
    const result = { ...await this.loadQuota(user.uid), all: MAX_STORAGE_BYTES };
    this.setCachedQuota(user.uid, result);
    return result;
  }

  async getOwnedStorageBytes(userId: string): Promise<number> {
    // Only the preliminary check can use a cache; the upload commit enforces quota transactionally.
    const cached = this.getCachedQuota(userId);
    if (cached) return Number(cached.used) || 0;
    return (await this.loadQuota(userId)).used;
  }

  private contentUrl(id: string, download = false): string {
    const base = process.env.PUBLIC_API_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://api.chefu.co.za';
    const url = new URL(`/cloudence/files/${encodeURIComponent(id)}/content`, base);
    if (download) url.searchParams.set('download', '1');
    return url.toString();
  }

  private async readableFile(user: AuthenticatedUser, id: string): Promise<CloudenceFileDocument> {
    const file = (await this.firebaseAdmin.db().collection(COLLECTION).doc(id).get()).data() as CloudenceFileDocument | undefined;
    if (!file || file.isDeleted) throw new NotFoundException('File was not found.');
    const isOwner = file.ownerId === user.uid;
    const email = user.email.trim().toLowerCase();
    const isShared = file.users.some((recipient) => recipient.trim().toLowerCase() === email);
    if (!isOwner && !isShared) throw new ForbiddenException('You do not have permission to access this file.');
    if (!isOwner && file.shareExpiresAt && Date.parse(file.shareExpiresAt) <= Date.now()) {
      throw new ForbiddenException('Sharing access for this file has expired.');
    }
    if (file.deliveryType !== 'authenticated') {
      throw new ServiceUnavailableException('This file is awaiting protected-storage migration.');
    }
    return file;
  }

  async getDownloadUrl(user: AuthenticatedUser, id: string) {
    const file = await this.readableFile(user, id);
    // This is an authenticated API URL, not a bearer link to Cloudinary.
    return { downloadUrl: this.contentUrl(id, true), name: file.name, sha256: file.sha256, size: file.size };
  }

  async openContent(user: AuthenticatedUser, id: string, options: { range?: string; preview?: boolean; signal?: AbortSignal } = {}) {
    const file = await this.readableFile(user, id);
    if (options.range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(options.range)) throw new BadRequestException('Only a single byte range is supported.');
    const resourceType = file.resourceType as 'image' | 'video' | 'raw';
    if (!['image', 'video', 'raw'].includes(resourceType)) throw new ServiceUnavailableException('Unsupported storage resource.');
    if (options.preview && (resourceType !== 'image' || file.type !== 'image')) throw new NotFoundException('No image preview is available.');
    const storageUrl = cloudinary.url(file.publicId, {
      sign_url: true, secure: true, type: 'authenticated', resource_type: resourceType,
      ...(resourceType !== 'raw' ? { format: options.preview ? 'png' : file.extension } : {}),
      ...(options.preview ? { width: 160, height: 160, crop: 'thumb', quality: 'auto' } : {}),
    });
    const upstream = await fetch(storageUrl, {
      headers: { 'Accept-Encoding': 'identity', ...(options.range ? { Range: options.range } : {}) }, signal: options.signal, redirect: 'error',
    });
    if (!upstream.ok && upstream.status !== 416) {
      await upstream.body?.cancel();
      throw new ServiceUnavailableException('File content could not be loaded. Please try again.');
    }
    return { file, upstream };
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

  private async withOwnerProfiles<T extends Pick<CloudenceFileDocument, 'ownerId' | 'owner'>>(files: T[]): Promise<T[]> {
    if (!files.length) return files;

    // Resolve each owner once per request, including owners of shared files.
    const allOwners = [...new Map(files.map((file) => [file.ownerId, file.owner])).entries()];
    const cachedNames = new Map<string, string>();
    const owners = allOwners.filter(([uid, owner]) => {
      const key = `${uid}:${owner.email.trim().toLowerCase()}`;
      const cached = this.ownerNames.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        cachedNames.set(uid, cached.name);
        return false;
      }
      this.ownerNames.delete(key);
      return true;
    });
    const emails = [...new Set(owners.map(([, owner]) => owner.email.trim().toLowerCase()).filter(Boolean))];
    const profiles = new Map<string, Record<string, unknown>>();
    try {
      if (emails.length) {
        const db = this.firebaseAdmin.db();
        const snapshots = await db.getAll(...emails.map((email) => db.collection('users').doc(email)));
        snapshots.forEach((snapshot, index) => profiles.set(emails[index], snapshot.data() || {}));
      }
    } catch (error) {
      this.logger.warn(`Owner profile lookup failed: ${error instanceof Error ? error.message : error}`);
    }

    const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
    const names = new Map([...cachedNames, ...await Promise.all(owners.map(async ([uid, owner]) => {
      const profile = profiles.get(owner.email.trim().toLowerCase()) || {};
      const emailName = owner.email.split('@')[0];
      let fullName = text(profile.fullname)
        || [text(profile.firstName), text(profile.lastName)].filter(Boolean).join(' ')
        || text(profile.displayName)
        || text(profile.name);

      // Older profiles may also contain the email-derived placeholder.
      if (!fullName || fullName === emailName) {
        try {
          const authUser = await this.firebaseAdmin.auth().getUser(uid);
          fullName = text(authUser.displayName) || fullName;
        } catch (error) {
          this.logger.warn(`Owner auth lookup failed: ${error instanceof Error ? error.message : error}`);
        }
      }

      // Cache display names only, never authorization or recipient membership.
      if (fullName && fullName !== emailName) {
        if (this.ownerNames.size >= 5000) this.ownerNames.delete(this.ownerNames.keys().next().value!);
        this.ownerNames.set(`${uid}:${owner.email.trim().toLowerCase()}`, { name: fullName, expiresAt: Date.now() + 5 * 60_000 });
      }
      return [uid, fullName || text(owner.fullName) || emailName || 'Cloudence User'] as const;
    }))]);

    return files.map((file) => ({
      ...file,
      owner: { ...file.owner, fullName: names.get(file.ownerId)! },
    }));
  }

  private sanitizeFileForUser(file: CloudenceFileDocument, user: AuthenticatedUser): CloudenceFileDocument {
    const safe = { ...file, url: this.contentUrl(file.id) };
    if (file.ownerId !== user.uid) {
      return { ...safe, users: [] };
    }
    return safe;
  }

  /**
   * Strip all server-only internal fields before sending to the controller.
   * This ensures sha256, ownerId, publicId, isDeleted, deletedAt, deletedBy,
   * resourceType, signedUrl are never serialised over HTTPS to the frontend.
   * Defense-in-depth: normalizeFile() on the Next.js side also strips them,
   * but this prevents leakage entirely at the API boundary.
   */
  toResponse(file: CloudenceFileDocument, user: AuthenticatedUser): CloudenceFileResponse {
    return {
      id: file.id,
      name: file.name,
      type: file.type,
      extension: file.extension,
      url: this.contentUrl(file.id),
      size: file.size,
      owner: file.owner,
      isOwner: file.ownerId === user.uid,
      users: file.users,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      shareExpiresAt: file.shareExpiresAt,
    };
  }

  /**
   * Combined dashboard endpoint: returns recent files + quota in one Firestore round-trip batch.
   * Avoids the two separate HTTP requests (getFiles + getTotalSpaceUsed) the dashboard page makes.
   */
  async dashboard(user: AuthenticatedUser) {
    const [listResult, quotaResult] = await Promise.all([
      this.list(user, { limit: 10 }),
      this.usage(user),
    ]);
    return {
      recentFiles: listResult.documents,
      quota: quotaResult,
    };
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

}
