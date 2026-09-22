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
