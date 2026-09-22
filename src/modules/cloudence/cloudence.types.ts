export type CloudenceFileType = 'document' | 'image' | 'video' | 'audio' | 'other';

export type CloudenceFileDocument = {
  id: string;
  name: string;
  type: CloudenceFileType;
  extension: string;
  url: string;
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

export type UploadCloudenceFileInput = {
  name?: string;
  contentType?: string;
  dataBase64?: string;
};

export type UpdateCloudenceFileInput = {
  name?: string;
  users?: string[];
  shareExpiresAt?: string;
};
