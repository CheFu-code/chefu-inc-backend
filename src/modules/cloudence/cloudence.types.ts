export type CloudenceFileType = 'document' | 'image' | 'video' | 'audio' | 'other';

export type CloudenceFileDocument = {
  id: string;
  name: string;
  type: CloudenceFileType;
  extension: string;
  /** Raw Cloudinary delivery URL (stored at upload time). */
  url: string;
  /** Legacy public URL, retained only for migration and never returned to clients. */
  signedUrl?: string;
  size: number;
  ownerId: string;
  owner: {
    id: string;
    fullName: string;
    email: string;
  };
  users: string[];
  publicId: string;
  resourceType: string;
  deliveryType?: 'upload' | 'authenticated';
  createdAt: string;
  updatedAt: string;
  isDeleted?: boolean;
  deletedAt?: string;
  deletedBy?: string;
  sha256?: string;
  shareExpiresAt?: string;
};

/** Kept for backward-compat; dataBase64 is no longer used — upload now accepts multipart via multer. */
export type UploadCloudenceFileInput = {
  name?: string;
  contentType?: string;
};

export type UpdateCloudenceFileInput = {
  name?: string;
  users?: string[];
  addUsers?: string[];
  removeUsers?: string[];
  shareExpiresAt?: string;
};

/**
 * Lean response DTO — only public-safe fields sent over HTTPS to the frontend.
 * Strips sha256, ownerId, publicId, isDeleted, deletedAt, deletedBy, resourceType, signedUrl.
 * Defense-in-depth: normalizeFile() on the Next.js side also strips, but this prevents
 * leakage at the API boundary regardless of what the frontend does.
 */
export type CloudenceFileResponse = {
  isOwner: boolean;
  id: string;
  name: string;
  type: CloudenceFileType;
  extension: string;
  /** Authenticated API content endpoint; storage URLs never leave the backend. */
  url: string;
  size: number;
  owner: { id: string; fullName: string; email: string };
  users: string[];
  createdAt: string;
  updatedAt: string;
  shareExpiresAt?: string;
};
