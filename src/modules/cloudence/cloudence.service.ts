import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { UploadApiOptions, v2 as cloudinary } from 'cloudinary';
import { assertCloudinaryConfigured } from '../../common/env';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import {
  CloudenceFileDocument,
  CloudenceFileType,
  UpdateCloudenceFileInput,
  UploadCloudenceFileInput,
} from './cloudence.types';

const COLLECTION = 'cloudenceFiles';
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['document', 'image', 'video', 'audio', 'other']);

@Injectable()
export class CloudenceService {
  private readonly logger = new Logger(CloudenceService.name);

  constructor(private readonly firebaseAdmin: FirebaseAdminService) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }

  async upload(user: AuthenticatedUser, input: UploadCloudenceFileInput) {
    assertCloudinaryConfigured();

    const name = String(input?.name || '').trim();
    const contentType = String(input?.contentType || 'application/octet-stream').toLowerCase();
    const rawBase64 = String(input?.dataBase64 || '');
    const base64 = rawBase64.replace(/^data:[^;]+;base64,/, '');

    if (!name || !base64 || !/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) {
      throw new BadRequestException('A valid file is required.');
    }

    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length || buffer.length > MAX_FILE_BYTES) {
      throw new BadRequestException('Files must be between 1 byte and 50 MB.');
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
    };

    await this.firebaseAdmin.db().collection(COLLECTION).doc(id).set(document);
    return document;
  }

  async list(user: AuthenticatedUser, input: { type?: string; search?: string; limit?: number }) {
    const collection = this.firebaseAdmin.db().collection(COLLECTION);
    const [ownedSnapshot, sharedSnapshot] = await Promise.all([
      collection.where('ownerId', '==', user.uid).get(),
      collection.where('users', 'array-contains', user.email).get(),
    ]);
    const search = String(input?.search || '').trim().toLowerCase();
    const type = String(input?.type || '').trim();
    const limit = Math.min(Math.max(Number(input?.limit || 100), 1), 100);
    const documents = [...ownedSnapshot.docs, ...sharedSnapshot.docs]
      .map((doc) => doc.data() as CloudenceFileDocument)
      .filter((file, index, files) => files.findIndex((candidate) => candidate.id === file.id) === index)
      .filter((file) => !type || type === 'all' || file.type === type)
      .filter((file) => !search || file.name.toLowerCase().includes(search))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);

    return { total: documents.length, documents };
  }

  async update(user: AuthenticatedUser, id: string, input: UpdateCloudenceFileInput) {
    const ref = this.firebaseAdmin.db().collection(COLLECTION).doc(id);
    const snapshot = await ref.get();
    const file = snapshot.data() as CloudenceFileDocument | undefined;
    this.assertCanEdit(file, user);

    const name = input.name === undefined ? file!.name : String(input.name).trim();
    if (!name) throw new BadRequestException('File name is required.');
    const users = input.users === undefined
      ? file!.users
      : [...new Set(input.users.map(String).map((email) => email.trim().toLowerCase()).filter(Boolean))];
    const updated = { ...file, name, users, updatedAt: new Date().toISOString() };
    await ref.set(updated);
    return updated;
  }

  async remove(user: AuthenticatedUser, id: string) {
    const ref = this.firebaseAdmin.db().collection(COLLECTION).doc(id);
    const snapshot = await ref.get();
    const file = snapshot.data() as CloudenceFileDocument | undefined;
    this.assertCanEdit(file, user);

    await ref.delete();
    await cloudinary.uploader.destroy(file!.publicId, { resource_type: file!.resourceType as 'image' | 'video' | 'raw' }).catch((error) => {
      this.logger.warn(`Cloudinary asset deletion failed for ${file!.publicId}: ${error instanceof Error ? error.message : error}`);
    });
    return { status: 'success' };
  }

  async usage(user: AuthenticatedUser) {
    const { documents } = await this.list(user, { limit: 100 });
    const totalSpace = {
      image: { size: 0, latestDate: '' },
      document: { size: 0, latestDate: '' },
      video: { size: 0, latestDate: '' },
      audio: { size: 0, latestDate: '' },
      other: { size: 0, latestDate: '' },
      used: 0,
      all: 2 * 1024 * 1024 * 1024,
    };

    for (const file of documents) {
      totalSpace[file.type].size += file.size;
      totalSpace.used += file.size;
      if (!totalSpace[file.type].latestDate || file.updatedAt > totalSpace[file.type].latestDate) {
        totalSpace[file.type].latestDate = file.updatedAt;
      }
    }

    return totalSpace;
  }

  private assertCanEdit(file: CloudenceFileDocument | undefined, user: AuthenticatedUser): asserts file is CloudenceFileDocument {
    if (!file) throw new NotFoundException('File was not found.');
    if (file.ownerId !== user.uid) throw new NotFoundException('File was not found.');
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

  private uploadBuffer(buffer: Buffer, options: UploadApiOptions): Promise<{ secure_url: string; public_id: string; resource_type?: string }> {
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
