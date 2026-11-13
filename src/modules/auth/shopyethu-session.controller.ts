import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard } from './auth.guard';
import { ShopYethuAdminGuard, ShopYethuRequest } from './shopyethu-admin.guard';

@Controller('auth/shopyethu')
@UseGuards(AuthGuard, ShopYethuAdminGuard)
export class ShopYethuSessionController {
  @Get('session')
  getSession(@Req() request: ShopYethuRequest, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'private, no-store');
    return { app: 'shopyethu', user: request.shopyethuAccount };
  }
}
