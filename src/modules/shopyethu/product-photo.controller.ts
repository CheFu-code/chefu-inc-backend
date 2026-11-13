import { BadRequestException, Body, Controller, Header, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CloudinaryStorageService } from '../../common/cloudinary-storage.service';
import { MarketplaceAuthGuard, MarketplaceRequest } from './marketplace-auth.guard';
import { MarketplaceService } from './marketplace.service';
import { seller } from './marketplace.validation';

@Controller('shopyethu/seller')
@UseGuards(MarketplaceAuthGuard)
export class ProductPhotoController {
  constructor(private readonly market: MarketplaceService, private readonly storage: CloudinaryStorageService) {}
  @Post('photos')
  @Header('Cache-Control', 'private, no-store')
  async upload(@Req() request: MarketplaceRequest, @Body() body: { image?: unknown }) {
    await seller(this.market.repo, request.user);
    if (typeof body.image !== 'string' || body.image.length > 2_800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.image)) throw new BadRequestException('Choose a JPEG, PNG or WebP photo smaller than 2 MB.');
    const buffer = Buffer.from(body.image, 'base64');
    const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const webp = buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
    if (buffer.length < 12 || buffer.length > 2 * 1024 * 1024 || !(jpeg || png || webp)) throw new BadRequestException('Use a JPEG, PNG or WebP photo smaller than 2 MB.');
    const asset = await this.storage.uploadBuffer(buffer, { resource_type: 'image', folder: `shopyethu/${request.user.uid}`, public_id: randomUUID(), transformation: [{ width: 1400, height: 1400, crop: 'limit' }] });
    // Permissions are checked again when attaching this URL to a product.
    return { url: asset.secure_url };
  }
}
