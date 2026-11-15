import { Injectable } from '@nestjs/common';
import { ApplicationsService } from './applications.service';
import { CatalogService } from './catalog.service';
import { OrdersService } from './orders.service';
import { ReportsService } from './reports.service';
import { FirestoreMarketplaceRepository } from './marketplace.repository';
import { ApplicationEmailService } from './application-email.service';

@Injectable()
export class MarketplaceService {
  readonly applications: ApplicationsService;
  readonly catalog: CatalogService;
  readonly orders: OrdersService;
  readonly reports: ReportsService;
  constructor(readonly repo: FirestoreMarketplaceRepository, email: ApplicationEmailService) {
    this.applications = new ApplicationsService(repo,
      application => email.send(application), application => email.sendApproval(application));
    this.catalog = new CatalogService(repo);
    this.orders = new OrdersService(repo);
    this.reports = new ReportsService(repo);
  }
}
