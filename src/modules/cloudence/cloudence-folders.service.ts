import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Transaction } from 'firebase-admin/firestore';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CloudenceFileDocument } from './cloudence.types';
import { COLLECTION } from './cloudence.constants';

export type FolderSection = 'documents' | 'images' | 'media' | 'others';
export type CloudenceFolder = { id: string; name: string; section: FolderSection; createdAt: string };
export type FolderSettings = { folders: CloudenceFolder[]; placements: Record<string, string>; cleanupCursor?: string };
export const MAX_BULK_MOVE = 50;
const FOLDERS_COLLECTION = 'cloudenceFolders';
const MAX_FOLDERS = 100;
const MAX_PLACEMENTS = 5000;

export function folderSection(type: string): FolderSection {
  return type === 'document' ? 'documents' : type === 'image' ? 'images' : ['audio', 'video'].includes(type) ? 'media' : 'others';
}

@Injectable()
export class CloudenceFoldersService {
  constructor(private readonly firebase: FirebaseAdminService) {}

  assertSection(section: unknown): asserts section is FolderSection {
    if (!['documents', 'images', 'media', 'others'].includes(String(section))) throw new BadRequestException('Choose a valid file section.');
  }

  private ref(user: AuthenticatedUser) { return this.firebase.db().collection(FOLDERS_COLLECTION).doc(user.uid); }
  private settings(value: FirebaseFirestore.DocumentData | undefined): FolderSettings {
    return { folders: value?.folders || [], placements: value?.placements || {}, ...(value?.cleanupCursor ? { cleanupCursor: value.cleanupCursor } : {}) };
  }
  async read(user: AuthenticatedUser) { return this.settings((await this.ref(user).get()).data()); }

  private name(value: unknown) {
    if (typeof value !== 'string') throw new BadRequestException('A folder name is required.');
    const name = value.normalize('NFKC').trim();
    if (!name || name.length > 80 || /[\x00-\x1f\x7f/\\]/.test(name) || ['.', '..'].includes(name)) {
      throw new BadRequestException('Use a folder name of 1–80 characters without slashes or control characters.');
    }
    return name;
  }

  async save(user: AuthenticatedUser, input: { section?: string; name?: string; id?: string; remove?: boolean }) {
    const name = input.remove ? undefined : this.name(input.name);
    if (!input.id) this.assertSection(input.section);
    const ref = this.ref(user);
    return this.firebase.db().runTransaction(async (transaction) => {
      const state = this.settings((await transaction.get(ref)).data());
      await this.prune(transaction, user, state);
      const existing = input.id ? state.folders.find((folder) => folder.id === input.id) : undefined;
      if (input.id && !existing) throw new NotFoundException('Folder was not found.');
      if (input.remove) {
        state.folders = state.folders.filter((folder) => folder.id !== input.id);
        state.placements = Object.fromEntries(Object.entries(state.placements).filter(([, id]) => id !== input.id));
      } else {
        const section = existing?.section || input.section as FolderSection;
        if (state.folders.some((folder) => folder.id !== input.id && folder.section === section && folder.name.toLowerCase() === name!.toLowerCase())) {
          throw new BadRequestException('A folder with that name already exists in this section.');
        }
        if (existing) existing.name = name!;
        else {
          if (state.folders.length >= MAX_FOLDERS) throw new BadRequestException(`You can create up to ${MAX_FOLDERS} folders.`);
          state.folders.push({ id: `folder_${randomUUID()}`, name: name!, section, createdAt: new Date().toISOString() });
        }
      }
      // Replace the map: merge:true would retain placements removed by deleting a folder.
      transaction.set(ref, state);
      return { folders: state.folders, status: 'success' };
    });
  }

  assertReadable(file: CloudenceFileDocument | undefined, user: AuthenticatedUser): asserts file is CloudenceFileDocument {
    if (!file || file.isDeleted) throw new NotFoundException('File was not found.');
    if (file.ownerId !== user.uid && (!user.email || !file.users.some((email) => email.toLowerCase() === user.email.toLowerCase()) ||
      (file.shareExpiresAt && Date.parse(file.shareExpiresAt) <= Date.now()))) throw new ForbiddenException('You do not have permission to organize this file.');
  }

  private place(state: FolderSettings, file: CloudenceFileDocument, folderId: unknown) {
    if (folderId === null || folderId === '') { delete state.placements[file.id]; return; }
    if (typeof folderId !== 'string') throw new BadRequestException('Choose a folder or the section root.');
    const folder = state.folders.find((folder) => folder.id === folderId);
    if (!folder) throw new NotFoundException('Folder was not found.');
    if (folder.section !== folderSection(file.type)) throw new BadRequestException('The file and folder must belong to the same section.');
    if (!state.placements[file.id] && Object.keys(state.placements).length >= MAX_PLACEMENTS) throw new BadRequestException(`You can organize up to ${MAX_PLACEMENTS} files in folders.`);
    state.placements[file.id] = folderId;
  }

  async move(user: AuthenticatedUser, fileId: string, folderId: unknown) {
    return this.moveMany(user, [fileId], folderId);
  }

  private validIds(value: unknown): string[] {
    if (!Array.isArray(value) || !value.length || value.length > MAX_BULK_MOVE || value.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id))) {
      throw new BadRequestException(`Select between 1 and ${MAX_BULK_MOVE} valid files.`);
    }
    return [...new Set(value)];
  }

  async moveMany(user: AuthenticatedUser, fileIds: unknown, folderId: unknown) {
    const ids = this.validIds(fileIds);
    const ref = this.ref(user);
    return this.firebase.db().runTransaction(async (transaction) => {
      const state = this.settings((await transaction.get(ref)).data());
      const files = await Promise.all(ids.map(async (id) => {
        const file = (await transaction.get(this.firebase.db().collection(COLLECTION).doc(id))).data() as CloudenceFileDocument | undefined;
        this.assertReadable(file, user);
        return file;
      }));
      const cleaned = await this.prune(transaction, user, state, new Map(files.map((file) => [file.id, file])));
      for (const file of files) this.place(state, file, folderId);
      transaction.set(ref, state);
      return { status: 'success', moved: files.length, cleaned: cleaned.cleaned, folderId: folderId || null };
    });
  }

  private async prune(transaction: Transaction, user: AuthenticatedUser, state: FolderSettings, known = new Map<string, CloudenceFileDocument>(), batchSize = 20) {
    const allIds = Object.keys(state.placements).sort();
    const after = state.cleanupCursor ? allIds.filter((id) => id > state.cleanupCursor!) : allIds;
    const candidates = after.length ? after : allIds;
    const ids = candidates.slice(0, batchSize);
    let cleaned = 0;
    await Promise.all(ids.map(async (id) => {
      const folder = state.folders.find((folder) => folder.id === state.placements[id]);
      if (!folder) { delete state.placements[id]; cleaned++; return; }
      const file = known.get(id) || (await transaction.get(this.firebase.db().collection(COLLECTION).doc(id))).data() as CloudenceFileDocument | undefined;
      try {
        this.assertReadable(file, user);
        if (folder.section !== folderSection(file.type)) { delete state.placements[id]; cleaned++; }
      }
      catch (error) {
        if (!(error instanceof NotFoundException || error instanceof ForbiddenException)) throw error;
        delete state.placements[id];
        cleaned++;
      }
    }));
    if (ids.length) state.cleanupCursor = ids[ids.length - 1];
    else delete state.cleanupCursor;
    return { cleaned, checked: ids.length, remaining: Math.max(0, candidates.length - ids.length) };
  }

  async cleanup(user: AuthenticatedUser) {
    const ref = this.ref(user);
    return this.firebase.db().runTransaction(async (transaction) => {
      const state = this.settings((await transaction.get(ref)).data());
      const result = await this.prune(transaction, user, state, new Map(), 100);
      if (result.checked) transaction.set(ref, state);
      return { status: 'success', ...result };
    });
  }

  async removePlacement(transaction: Transaction, user: AuthenticatedUser, fileId: string) {
    const ref = this.ref(user);
    const state = this.settings((await transaction.get(ref)).data());
    if (state.placements[fileId]) {
      delete state.placements[fileId];
      transaction.set(ref, state);
    }
  }

  async placeUpload(transaction: Transaction, user: AuthenticatedUser, file: CloudenceFileDocument, folderId: string) {
    const ref = this.ref(user);
    const state = this.settings((await transaction.get(ref)).data());
    this.place(state, file, folderId);
    transaction.set(ref, state);
  }

  validateDestination(state: FolderSettings, section: string, folderId: string) {
    this.assertSection(section);
    const folder = state.folders.find((folder) => folder.id === folderId && folder.section === section);
    if (!folder) throw new NotFoundException('Folder was not found in this section.');
    return folder;
  }
}
