import { Controller, Get, Header, Injectable, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { COLLECTION } from './cloudence.constants';
import type { CloudenceFileDocument } from './cloudence.types';
import { analyzeStorageHealth, HEALTH_SCAN_LIMIT } from './storage-health.analysis';

@Injectable()
export class StorageHealthService {
  constructor(private readonly firebase: FirebaseAdminService) {}

  async scan(user: AuthenticatedUser) {
    // Ownership comes from the authenticated session, never a request parameter.
    const snapshot = await this.firebase.db().collection(COLLECTION)
      .where('ownerId', '==', user.uid)
      .select('name', 'size', 'type', 'extension', 'createdAt', 'updatedAt', 'owner', 'ownerId', 'users', 'sha256', 'isDeleted', 'storageProvider', 'storageKey', 'publicId', 'resourceType', 'deliveryType')
      .limit(HEALTH_SCAN_LIMIT + 1).get();
    const files = snapshot.docs.slice(0, HEALTH_SCAN_LIMIT).map(document => (
      { ...document.data(), id: document.id } as CloudenceFileDocument
    ));
    return analyzeStorageHealth(files, user.uid, Date.now(), snapshot.size > HEALTH_SCAN_LIMIT);
  }
}

@Controller('cloudence/storage-health')
@UseGuards(AuthGuard)
export class StorageHealthController {
  constructor(private readonly health: StorageHealthService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  scan(@Req() request: Request & { user?: AuthenticatedUser }) {
    if (!request.user) throw new UnauthorizedException('Authenticated user missing.');
    return this.health.scan(request.user);
  }
}
