import { BadRequestException, Injectable } from '@nestjs/common';
import { UploadApiOptions, v2 as cloudinary } from 'cloudinary';
import { Readable } from 'node:stream';
import { assertCloudinaryConfigured } from './env';

export type CloudinaryUploadResult = {
  secure_url: string;
  public_id: string;
  resource_type?: string;
};

@Injectable()
export class CloudinaryStorageService {
  constructor() {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }

  uploadBuffer(buffer: Buffer, options: UploadApiOptions): Promise<CloudinaryUploadResult> {
    assertCloudinaryConfigured();
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
        if (error) return reject(new BadRequestException('File upload failed.'));
        if (!result?.secure_url || !result.public_id) {
          return reject(new BadRequestException('File upload returned no asset.'));
        }
        resolve({
          secure_url: result.secure_url,
          public_id: result.public_id,
          resource_type: result.resource_type,
        });
      });
      Readable.from(buffer).pipe(stream);
    });
  }

  async delete(publicId: string, resourceType: 'image' | 'video' | 'raw') {
    assertCloudinaryConfigured();
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
      invalidate: true,
    });
    if (result.result !== 'ok' && result.result !== 'not found') {
      throw new Error(`Cloudinary asset deletion failed (${result.result}).`);
    }
  }
}
