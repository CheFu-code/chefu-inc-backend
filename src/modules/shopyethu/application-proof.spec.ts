import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import type { UploadApiOptions } from 'cloudinary';
import { ApplicationProofController } from './application-proof.controller';
import type { MarketplaceRequest } from './marketplace-auth.guard';
import type { CloudinaryStorageService } from '../../common/cloudinary-storage.service';

function requestFor(uid: string): MarketplaceRequest {
  return {
    user: { uid, email: 'owner@example.test', roles: [] },
  } as unknown as MarketplaceRequest;
}

function storageWithUpload(
  uploadBuffer: CloudinaryStorageService['uploadBuffer'],
): CloudinaryStorageService {
  return {
    uploadBuffer,
    privateDownloadUrl: () => '',
    delete: async () => {},
  };
}

void test('CIPC proof upload stores validated files as private raw assets', async () => {
  const uploads: { buffer: Buffer; options: UploadApiOptions }[] = [];
  const controller = new ApplicationProofController(
    storageWithUpload(async (buffer, options) => {
      uploads.push({ buffer, options });
      return {
        secure_url: 'https://private.example.test/certificate',
        public_id: `${options.folder}/${options.public_id}.pdf`,
      };
    }),
  );
  const request = requestFor('applicant-1');
  const file = Buffer.from('%PDF-1.7\nCIPC certificate');
  const result = await controller.upload(request, {
    file: file.toString('base64'),
    format: 'pdf',
  });
  assert.equal(result.assetId, `shopyethu-applications/${request.user.uid}/${uploads[0].options.public_id}.pdf`);
  assert.equal(result.format, 'pdf');
  assert.equal(uploads[0].options.resource_type, 'raw');
  assert.equal(uploads[0].options.type, 'authenticated');
  assert.deepEqual(uploads[0].buffer, file);
});

void test('CIPC proof upload rejects mismatched content and unsupported formats', async () => {
  const controller = new ApplicationProofController(
    storageWithUpload(async () => {
      throw new Error('Invalid files must not be uploaded.');
    }),
  );
  const request = requestFor('applicant-1');
  await assert.rejects(
    controller.upload(request, {
      file: Buffer.from('not a PDF').toString('base64'),
      format: 'pdf',
    }),
    (error: BadRequestException) => error.getStatus() === 400,
  );
  await assert.rejects(
    controller.upload(request, {
      file: Buffer.from('%PDF-1.7\ncertificate').toString('base64'),
      format: 'exe',
    }),
    (error: BadRequestException) => error.getStatus() === 400,
  );
});
