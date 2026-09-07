import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AdminGuard } from '../auth/admin.guard';
import { AuthGuard } from '../auth/auth.guard';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { ProductsService } from './products.service';
import { InventoryInput, ProductInput, UploadImageInput } from './products.types';

type RequestWithUser = Request & { user?: AuthenticatedUser };

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  listPublicProducts() {
    return this.products.listPublicProducts();
  }

  @Get('slug/:slug')
  getBySlug(@Param('slug') slug: string) {
    return this.products.getProductBySlug(slug, false);
  }

  @Get('admin')
  @UseGuards(AuthGuard, AdminGuard)
  listAdminProducts() {
    return this.products.listAdminProducts();
  }

  @Post()
  @UseGuards(AuthGuard, AdminGuard)
  create(@Req() request: RequestWithUser, @Body() body: ProductInput) {
    return this.products.create(this.requireUser(request), body);
  }

  @Put(':id')
  @UseGuards(AuthGuard, AdminGuard)
  update(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: ProductInput) {
    return this.products.update(this.requireUser(request), id, body);
  }

  @Delete(':id')
  @UseGuards(AuthGuard, AdminGuard)
  archive(@Req() request: RequestWithUser, @Param('id') id: string) {
    return this.products.archive(this.requireUser(request), id);
  }

  @Patch(':id/inventory')
  @UseGuards(AuthGuard, AdminGuard)
  adjustInventory(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: InventoryInput) {
    return this.products.adjustInventory(this.requireUser(request), id, body);
  }

  @Post('upload-image')
  @UseGuards(AuthGuard, AdminGuard)
  uploadImage(@Req() request: RequestWithUser, @Body() body: UploadImageInput) {
    return this.products.uploadImage(this.requireUser(request), body);
  }

  private requireUser(request: RequestWithUser) {
    if (!request.user) throw new UnauthorizedException('Authenticated user missing from request.');
    return request.user;
  }
}