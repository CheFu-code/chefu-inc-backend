import { Module } from '@nestjs/common';
import { CloudinaryStorageService } from './cloudinary-storage.service';

@Module({
  providers: [CloudinaryStorageService],
  exports: [CloudinaryStorageService],
})
export class CloudinaryStorageModule {}
