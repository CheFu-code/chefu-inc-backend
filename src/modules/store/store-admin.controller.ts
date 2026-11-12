import { Body, Controller, Get, Header, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { StoreJobsService } from './store-jobs.service';
import type { CheckoutRequest } from './checkout-access.guard';
import { validateReference } from './checkout.validation';

@Controller('store/admin')
@UseGuards(AuthGuard, AdminGuard)
export class StoreAdminController {
  constructor(@Inject(FirebaseAdminService) private readonly firebase: FirebaseAdminService, @Inject(StoreJobsService) private readonly jobs: StoreJobsService) {}
  @Get('alerts')
  @Header('Cache-Control', 'private, no-store')
  async alerts() {
    const snapshot = await this.firebase.db().collection('storeAlerts').where('resolved', '==', false).orderBy('createdAt', 'desc').limit(50).get();
    return { alerts: snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) };
  }
  @Post('retry-job')
  @Header('Cache-Control', 'private, no-store')
  retry(@Req() request: CheckoutRequest, @Body() body: unknown) { return this.jobs.retry(validateReference(body), request.user!.uid); }
}
