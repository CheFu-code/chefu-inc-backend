import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { ShopYethuAdminGuard } from '../auth/shopyethu-admin.guard';
import type { MarketplaceRequest } from './marketplace-auth.guard';
import { MarketplaceService } from './marketplace.service';

@Controller('shopyethu/admin')
@UseGuards(AuthGuard, ShopYethuAdminGuard)
export class MarketplaceAdminController {
  constructor(private readonly market: MarketplaceService) {}
  @Get('applications') async applications() { return { applications: await this.market.repo.list('applications') }; }
  @Get('reports') async reports() { return { reports: await this.market.repo.list('reports') }; }
  @Get('sellers') async sellers() { return { sellers: await this.market.repo.list('stores') }; }
  @Put('applications/:uid') review(@Req() req: MarketplaceRequest, @Param('uid') uid: string, @Body() body: Record<string, unknown>) { return this.market.applications.review(req.user, uid, body); }
  @Put('sellers/:uid') suspend(@Req() req: MarketplaceRequest, @Param('uid') uid: string, @Body() body: Record<string, unknown>) { return this.market.applications.suspend(req.user, uid, body); }
}
