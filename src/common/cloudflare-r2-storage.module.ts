import { Module } from '@nestjs/common';
import { CloudflareR2StorageService } from './cloudflare-r2-storage.service';

@Module({
  providers: [CloudflareR2StorageService],
  exports: [CloudflareR2StorageService],
})
export class CloudflareR2StorageModule {}
