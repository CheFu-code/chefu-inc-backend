import { Injectable } from '@nestjs/common';
import { ApplicationsService } from './applications.service';
import { CatalogService } from './catalog.service';
import { OrdersService } from './orders.service';
import { ReportsService } from './reports.service';
import { ReviewsService } from './reviews.service';
import { FirestoreMarketplaceRepository } from './marketplace.repository';
import { ApplicationEmailService } from './application-email.service';
import { OrderEmailService } from './order-email.service';
import { GooglePlacesService } from './google-places.service';

@Injectable()
export class MarketplaceService {
  readonly applications: ApplicationsService;
  readonly catalog: CatalogService;
  readonly orders: OrdersService;
  readonly reports: ReportsService;
  readonly reviews: ReviewsService;
  constructor(readonly repo: FirestoreMarketplaceRepository, email: ApplicationEmailService, orderEmail: OrderEmailService, places?: GooglePlacesService) {
    this.applications = new ApplicationsService(repo,
      application => email.send(application), application => email.sendApproval(application), places);
    this.catalog = new CatalogService(repo, places);
    this.orders = new OrdersService(repo, receipt => orderEmail.send(receipt));
    this.reports = new ReportsService(repo);
    this.reviews = new ReviewsService(repo);
  }
}
