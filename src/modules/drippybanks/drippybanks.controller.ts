import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { DrippybanksService } from './drippybanks.service';
import {
  CreateProductInput,
  UpdateProductInput,
  UploadImageInput,
  GeneratePayFastPaymentInput,
} from './drippybanks.types';

type RequestWithUser = Request & {
  user?: AuthenticatedUser;
};

@Controller('drippybanks')
export class DrippybanksController {
  constructor(private readonly drippybanksService: DrippybanksService) {}

  @Get('products')
  async listProducts() {
    return this.drippybanksService.listProducts();
  }

  @Get('products/:id')
  async getProduct(@Param('id') id: string) {
    return this.drippybanksService.getProductById(id);
  }

  @Post('upload-image')
  @UseGuards(AuthGuard, AdminGuard)
  async uploadImage(
    @Req() request: RequestWithUser,
    @Body() body: UploadImageInput,
  ) {
    const user = this.requireUser(request);
    return this.drippybanksService.uploadImage(user, body);
  }

  @Post('products')
  @UseGuards(AuthGuard, AdminGuard)
  async createProduct(
    @Req() request: RequestWithUser,
    @Body() body: CreateProductInput,
  ) {
    const user = this.requireUser(request);
    return this.drippybanksService.createProduct(user, body);
  }

  @Put('products/:id')
  @UseGuards(AuthGuard, AdminGuard)
  async updateProduct(
    @Req() request: RequestWithUser,
    @Param('id') id: string,
    @Body() body: UpdateProductInput,
  ) {
    const user = this.requireUser(request);
    return this.drippybanksService.updateProduct(user, id, body);
  }

  @Delete('products/:id')
  @UseGuards(AuthGuard, AdminGuard)
  async deleteProduct(
    @Req() request: RequestWithUser,
    @Param('id') id: string,
  ) {
    const user = this.requireUser(request);
    return this.drippybanksService.deleteProduct(user, id);
  }

  @Post('products/:id/toggle-stock')
  @UseGuards(AuthGuard, AdminGuard)
  async toggleStock(
    @Req() request: RequestWithUser,
    @Param('id') id: string,
  ) {
    const user = this.requireUser(request);
    return this.drippybanksService.toggleStock(user, id);
  }

  @Post('payfast/generate-payment')
  @UseGuards(AuthGuard)
  generatePayFastPayment(
    @Body() body: GeneratePayFastPaymentInput,
  ) {
    return this.drippybanksService.generatePayFastPayment(body);
  }

  @Post('payfast/notify')
  async payfastNotify(
    @Body() body: Record<string, unknown>,
  ) {
    return this.drippybanksService.handlePayFastNotify(body);
  }

  private requireUser(request: RequestWithUser): AuthenticatedUser {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user missing from request.');
    }

    return request.user;
  }
}
