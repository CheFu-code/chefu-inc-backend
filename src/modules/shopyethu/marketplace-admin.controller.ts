import { Body, Controller, Get, Header, NotFoundException, Param, Put, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { ShopYethuAdminGuard } from '../auth/shopyethu-admin.guard';
import type { MarketplaceRequest } from './marketplace-auth.guard';
import { MarketplaceService } from './marketplace.service';
import { CloudinaryStorageService } from '../../common/cloudinary-storage.service';
import type { SellerApplication } from './marketplace.types';

@Controller('shopyethu/admin')
@UseGuards(AuthGuard, ShopYethuAdminGuard)
export class MarketplaceAdminController {
  constructor(private readonly market: MarketplaceService, private readonly storage: CloudinaryStorageService) {}
  @Get('applications') async applications() { return { applications: await this.market.repo.list('applications') }; }
  @Get('applications/:uid/cipc-proof')
  @Header('Cache-Control', 'private, no-store')
  async cipcProof(@Param('uid') uid: string) {
    const application = await this.market.repo.get<SellerApplication>('applications', uid);
    if (!application?.cipcCertificateId || !application.cipcCertificateFormat) {
      throw new NotFoundException('CIPC certificate not found.');
    }
    const prefix = `shopyethu-applications/${uid}/`;
    const assetName = application.cipcCertificateId.startsWith(prefix)
      ? application.cipcCertificateId.slice(prefix.length)
      : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.(?:pdf|jpg|png|webp))?$/i.test(assetName)) {
      throw new NotFoundException('CIPC certificate not found.');
    }
    return { url: this.storage.privateDownloadUrl(application.cipcCertificateId, application.cipcCertificateFormat) };
  }
  @Get('reports') async reports() { return { reports: await this.market.repo.list('reports') }; }
  @Get('sellers') async sellers() { return { sellers: await this.market.repo.list('stores') }; }
  @Put('applications/:uid') review(@Req() req: MarketplaceRequest, @Param('uid') uid: string, @Body() body: Record<string, unknown>) { return this.market.applications.review(req.user, uid, body); }
  @Put('sellers/:uid') suspend(@Req() req: MarketplaceRequest, @Param('uid') uid: string, @Body() body: Record<string, unknown>) { return this.market.applications.suspend(req.user, uid, body); }
}
