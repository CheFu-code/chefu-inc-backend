import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';

const MAX_IMAGE_PIXELS = 40_000_000;

export async function stripImageMetadata(
  buffer: Buffer,
  maxBytes: number,
): Promise<Buffer> {
  const image = sharp(buffer, {
    animated: true,
    failOn: 'error',
    limitInputPixels: MAX_IMAGE_PIXELS,
  });
  let metadata: sharp.Metadata;
  try {
    metadata = await image.metadata();
  } catch {
    throw new BadRequestException('The image could not be safely sanitized.');
  }
  if (!metadata.format) {
    throw new BadRequestException('Unsupported image format.');
  }
  if (
    metadata.width &&
    metadata.height &&
    metadata.width * metadata.height > MAX_IMAGE_PIXELS
  ) {
    throw new BadRequestException('Image dimensions exceed the safe processing limit.');
  }

  let output: Buffer;
  try {
    const oriented = image.rotate();
    switch (metadata.format) {
      case 'jpeg':
        output = await oriented
          .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
          .toBuffer();
        break;
      case 'png':
        output = await oriented.png().toBuffer();
        break;
      case 'webp':
        output = await oriented.webp({ quality: 100 }).toBuffer();
        break;
      case 'gif':
        output = await oriented.gif().toBuffer();
        break;
      case 'tiff':
        output = await oriented.tiff({ quality: 100 }).toBuffer();
        break;
      case 'heif':
        output = await oriented.heif({ quality: 100 }).toBuffer();
        break;
      default:
        throw new BadRequestException('Unsupported image format for safe storage.');
    }
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('The image could not be safely sanitized.');
  }

  if (output.length > maxBytes) {
    throw new BadRequestException('Sanitized image exceeds the allowed file size.');
  }
  return output;
}
