import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { CloudinaryStorageService } from '../../common/cloudinary-storage.service';
import { ProfilePictureService } from '../auth/profile-picture.service';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { NookSocialService } from './nook-social.service';

void test('social uploads reject video posts and allow image posts', async () => {
  const createdUploads: Array<Record<string, unknown>> = [];
  const firebaseAdmin = {
    db: () => ({
      collection: () => ({
        doc: () => ({
          create: async (upload: Record<string, unknown>) => {
            createdUploads.push(upload);
          },
        }),
      }),
    }),
  };
  const service = new NookSocialService(
    firebaseAdmin as unknown as FirebaseAdminService,
    undefined as unknown as ProfilePictureService,
    undefined as unknown as CloudinaryStorageService,
  );

  await assert.rejects(
    service.createUpload(
      { uid: 'user-1' } as Parameters<NookSocialService['createUpload']>[0],
      { purpose: 'post', kind: 'video', width: 1920, height: 1080, duration: 15 } as unknown as
        Parameters<NookSocialService['createUpload']>[1],
    ),
    (error: unknown) =>
      error instanceof BadRequestException &&
      error.message === 'Invalid upload purpose or media type.',
  );

  await service.createUpload(
    { uid: 'user-1' } as Parameters<NookSocialService['createUpload']>[0],
    { purpose: 'post', kind: 'image', width: 1200, height: 800 },
  );

  assert.equal(createdUploads.length, 1);
  assert.equal(createdUploads[0].kind, 'image');
  assert.equal(createdUploads[0].purpose, 'post');
  assert.equal('duration' in createdUploads[0], false);
});
