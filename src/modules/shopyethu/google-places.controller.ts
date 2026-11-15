import { Body, Controller, Get, Header, Param, Post, Req, UseGuards } from '@nestjs/common';
import { MarketplaceAuthGuard, MarketplaceRequest } from './marketplace-auth.guard';
import { GooglePlacesService } from './google-places.service';

@Controller('shopyethu/application/areas')
@UseGuards(MarketplaceAuthGuard)
export class ApplicationAreasController {
  constructor(private readonly places: GooglePlacesService) {}

  @Post('suggestions')
  @Header('Cache-Control', 'private, no-store')
  suggestions(@Req() _request: MarketplaceRequest, @Body() body: { input?: unknown; sessionToken?: unknown }) {
    return this.places.suggestions(body.input, body.sessionToken);
  }

  @Post('resolve')
  @Header('Cache-Control', 'private, no-store')
  resolve(@Req() _request: MarketplaceRequest, @Body() body: { placeId?: unknown; sessionToken?: unknown }) {
    return this.places.resolve(body.placeId, body.sessionToken);
  }
}

@Controller('shopyethu/areas')
export class PublicAreasController {
  constructor(private readonly places: GooglePlacesService) {}

  @Get(':placeId')
  @Header('Cache-Control', 'no-store')
  resolve(@Param('placeId') placeId: string) {
    return this.places.resolve(placeId);
  }
}
