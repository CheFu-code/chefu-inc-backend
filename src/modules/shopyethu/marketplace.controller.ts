import { Body, Controller, Get, Header, Headers, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { MarketplaceService } from './marketplace.service';
import { MarketplaceAuthGuard, MarketplaceRequest } from './marketplace-auth.guard';

@Controller('shopyethu')
export class MarketplacePublicController {
  constructor(private readonly market: MarketplaceService) {}
  @Get('config') config() { return { payments: 'not-configured', collectionEnabled: true, deliveryCents: 0 }; }
  @Get('products') @Header('Cache-Control', 'no-store')
  async products(@Query('q') q = '', @Query('category') category = '', @Query('store') store = '', @Query('after') after = '', @Query('page') page = '') {
    if (page === '1' || after) return this.market.catalog.page(q.slice(0, 120), category.slice(0, 60), store.slice(0, 150), after);
    return { products: await this.market.catalog.browse(q.slice(0, 120), category.slice(0, 60), store.slice(0, 150)) };
  }
  @Get('products/:id') product(@Param('id') id: string) { return this.market.catalog.product(id); }
  @Get('stores/:id') storefront(@Param('id') id: string) { return this.market.catalog.storefront(id); }
}

@Controller('shopyethu')
@UseGuards(MarketplaceAuthGuard)
export class MarketplaceCustomerController {
  constructor(private readonly market: MarketplaceService) {}
  @Get('me') me(@Req() req: MarketplaceRequest) { return this.market.applications.account(req.user); }
  @Post('application') application(@Req() req: MarketplaceRequest, @Body() body: Record<string, unknown>) { return this.market.applications.submit(req.user, body); }
  @Get('orders') async orders(@Req() req: MarketplaceRequest) { return { orders: await this.market.orders.list(req.user) }; }
  @Post('orders') order(@Req() req: MarketplaceRequest, @Body() body: Record<string, unknown>, @Headers('idempotency-key') key: string) { return this.market.orders.place(req.user, body, key); }
  @Post('reports') report(@Req() req: MarketplaceRequest, @Body() body: Record<string, unknown>) { return this.market.reports.submit(req.user, body); }
  @Get('seller/store') mine(@Req() req: MarketplaceRequest) { return this.market.catalog.mine(req.user); }
  @Get('seller/products/:id') ownProduct(@Req() req: MarketplaceRequest, @Param('id') id: string) { return this.market.catalog.ownProduct(req.user, id); }
  @Put('seller/store') store(@Req() req: MarketplaceRequest, @Body() body: Record<string, unknown>) { return this.market.catalog.saveStore(req.user, body); }
  @Post('seller/products') createProduct(@Req() req: MarketplaceRequest, @Body() body: Record<string, unknown>, @Headers('idempotency-key') key?: string) { return this.market.catalog.saveProduct(req.user, body, undefined, key); }
  @Put('seller/products/:id') updateProduct(@Req() req: MarketplaceRequest, @Param('id') id: string, @Body() body: Record<string, unknown>, @Headers('idempotency-key') key?: string) { return this.market.catalog.saveProduct(req.user, body, id, key); }
  @Get('seller/orders') async incoming(@Req() req: MarketplaceRequest) { return { orders: await this.market.orders.list(req.user, true) }; }
  @Put('seller/orders/:id') status(@Req() req: MarketplaceRequest, @Param('id') id: string, @Body() body: { status?: unknown }) { return this.market.orders.update(req.user, id, body.status); }
  @Put('seller/orders/:id/payment') confirmPayment(@Req() req: MarketplaceRequest, @Param('id') id: string) { return this.market.orders.confirmPayment(req.user, id); }
}
