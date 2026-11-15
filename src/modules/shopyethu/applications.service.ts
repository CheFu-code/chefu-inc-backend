import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Actor, MarketplaceRepository, SellerApplication, Storefront, ApplicationStatus } from './marketplace.types';
import { assertAdmin, exists, text } from './marketplace.validation';
import { applicationFields, applicationHistory } from './application.validation';
import type { GooglePlacesService } from './google-places.service';

export class ApplicationsService {
  private readonly logger = new Logger(ApplicationsService.name);
  constructor(
    private readonly repo: MarketplaceRepository,
    private readonly confirmation?: (application: SellerApplication) => Promise<void>,
    private readonly approval?: (application: SellerApplication) => Promise<void>,
    private readonly places?: Pick<GooglePlacesService, 'resolve'>,
  ) {}
  async account(actor: Actor) {
    const [application, store] = await Promise.all([
      this.repo.get<SellerApplication>('applications', actor.uid), this.repo.get<Storefront>('stores', actor.uid),
    ]);
    return { user: { uid: actor.uid, email: actor.email }, application, store };
  }
  async submit(actor: Actor, body: Record<string, unknown>) {
    const fields = applicationFields(actor, body);
    if (fields.areaPlaceId) {
      if (!this.places) throw new ServiceUnavailableException('Location search is temporarily unavailable.');
      await this.places.resolve(fields.areaPlaceId, body.areaSessionToken);
    }
    const saved = await this.repo.transaction(async tx => {
      const previous = await tx.get<SellerApplication>('applications', actor.uid);
      if (previous && previous.status !== 'more-info') throw new BadRequestException('This application cannot be resubmitted in its current status.');
      if (previous?.status === 'more-info' && fields.response.length < 5) throw new BadRequestException('Respond to the information requested by CheFu.');
      const now = new Date().toISOString();
      const event = { status: 'pending' as const, at: now, ...(previous ? { response: fields.response } : {}) };
      const application: SellerApplication = {
        ...fields, id: actor.uid, ownerUid: actor.uid, status: 'pending', reason: previous?.reason || '',
        updatedAt: now, contactConfirmedAt: now,
        ...(!previous ? { createdAt: now } : previous.createdAt ? { createdAt: previous.createdAt } : {}),
        history: previous ? applicationHistory(previous, event) : [event],
      };
      tx.set('applications', actor.uid, application);
      return application;
    });
    // Firestore can repeat transaction callbacks. External side effects belong after commit.
    try { await this.confirmation?.(saved); }
    catch {
      this.logger.warn(JSON.stringify({ event: 'shopyethu_application_confirmation_failed' }));
    }
    return saved;
  }
  async review(actor: Actor, uid: string, body: Record<string, unknown>) {
    assertAdmin(actor);
    const status = body.status as ApplicationStatus;
    if (!['more-info', 'approved', 'rejected'].includes(status)) throw new BadRequestException('Invalid review decision.');
    const reason = text(body.reason ?? '', 'Customer-facing reason', status === 'approved' ? 0 : 5, 2000);
    const saved = await this.repo.transaction(async tx => {
      const application = exists(await tx.get<SellerApplication>('applications', uid), 'Application');
      const existing = await tx.get<Storefront>('stores', uid);
      if (!['pending', 'more-info'].includes(application.status)) throw new BadRequestException('This application has already been decided.');
      const now = new Date().toISOString();
      const updated = { ...application, status, reason, updatedAt: now, history: applicationHistory(application, { status, reason, at: now }) };
      tx.set('applications', uid, updated);
      if (status === 'approved' && !existing) tx.set('stores', uid, {
        id: uid, ownerUid: uid, name: application.businessName, description: application.plans,
        area: application.area, ...(application.areaPlaceId ? { areaPlaceId: application.areaPlaceId } : {}),
        status: 'active', reason: '', updatedAt: updated.updatedAt,
      });
      return updated;
    });
    if (saved.status === 'approved') {
      try { await this.approval?.(saved); }
      catch {
        this.logger.warn(JSON.stringify({ event: 'shopyethu_application_approval_email_failed' }));
      }
    }
    return saved;
  }
  async suspend(actor: Actor, uid: string, body: Record<string, unknown>) {
    assertAdmin(actor);
    if (!['active', 'suspended'].includes(String(body.status))) throw new BadRequestException('Invalid seller status.');
    return this.repo.transaction(async tx => {
      const store = exists(await tx.get<Storefront>('stores', uid), 'Store');
      const updated = { ...store, status: body.status as Storefront['status'], reason: text(body.reason ?? '', 'Reason', 0, 1000), updatedAt: new Date().toISOString() };
      tx.set('stores', uid, updated); return updated;
    });
  }
}
