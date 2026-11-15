import { BadRequestException, Body, Controller, Header, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CloudinaryStorageService } from '../../common/cloudinary-storage.service';
import { MarketplaceAuthGuard, MarketplaceRequest } from './marketplace-auth.guard';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BASE64_LENGTH = 2_800_000;

function certificateFormat(value: unknown): value is 'pdf' | 'jpg' | 'png' | 'webp' {
  return value === 'pdf' || value === 'jpg' || value === 'png' || value === 'webp';
}

@Controller('shopyethu/application')
@UseGuards(MarketplaceAuthGuard)
export class ApplicationProofController {
  constructor(private readonly storage: CloudinaryStorageService) {}

  @Post('proof')
  @Header('Cache-Control', 'private, no-store')
  async upload(@Req() request: MarketplaceRequest, @Body() body: { file?: unknown; format?: unknown }) {
    if (typeof body.file !== 'string' || body.file.length > MAX_BASE64_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.file)) {
      throw new BadRequestException('Choose a PDF or image smaller than 2 MB.');
    }
    const format = body.format === 'jpeg' ? 'jpg' : body.format;
    if (!certificateFormat(format)) {
      throw new BadRequestException('Use a PDF, JPG, PNG or WebP file.');
    }
    const buffer = Buffer.from(body.file, 'base64');
    const validPdf = buffer.subarray(0, 5).toString() === '%PDF-';
    const validJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const validPng = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const validWebp = buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
    const validFormat = format === 'pdf' ? validPdf : format === 'jpg' ? validJpeg : format === 'png' ? validPng : validWebp;
    if (!buffer.length || buffer.length > MAX_FILE_BYTES || !validFormat) {
      throw new BadRequestException('The selected file is invalid or larger than 2 MB.');
    }
    const asset = await this.storage.uploadBuffer(buffer, {
      resource_type: 'raw',
      type: 'authenticated',
      folder: `shopyethu-applications/${request.user.uid}`,
      public_id: randomUUID(),
      format,
      overwrite: false,
      discard_original_filename: true,
    });
    return { assetId: asset.public_id, format };
  }
}
