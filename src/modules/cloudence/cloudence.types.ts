export type CloudenceFileType = 'document' | 'image' | 'video' | 'audio' | 'other';

export type CloudenceFileDocument = {
  id: string;
  name: string;
  type: CloudenceFileType;
  extension: string;
  /** Raw Cloudinary delivery URL (stored at upload time). */
  url: string;
  /** Pre-computed signed delivery URL cached in Firestore (avoids HMAC on every list). */
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
  shareExpiresAt?: string;
};

/**
 * Lean response DTO — only public-safe fields sent over HTTPS to the frontend.
 * Strips sha256, ownerId, publicId, isDeleted, deletedAt, deletedBy, resourceType, signedUrl.
 * Defense-in-depth: normalizeFile() on the Next.js side also strips, but this prevents
 * leakage at the API boundary regardless of what the frontend does.
 */
export type CloudenceFileResponse = {
  id: string;
  name: string;
  type: CloudenceFileType;
  extension: string;
  /** Resolved signed delivery URL — pre-computed at upload, not re-derived per request. */
  url: string;
  size: number;
  owner: { id: string; fullName: string; email: string };
  users: string[];
  createdAt: string;
  updatedAt: string;
  shareExpiresAt?: string;
};
