import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
  CreateOrderInput,
  DrippybanksOrderStatus,
  UpdateProductInput,
  UpdateOrderStatusInput,
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
    @Req() request: RequestWithUser,
    @Body() body: GeneratePayFastPaymentInput,
  ) {
    const user = this.requireUser(request);
    return this.drippybanksService.generatePayFastPayment(user, body);
  }

  @Post('orders')
  @UseGuards(AuthGuard)
  createOrder(
    @Req() request: RequestWithUser,
    @Body() body: CreateOrderInput,
  ) {
    const user = this.requireUser(request);
    return this.drippybanksService.createOrder(user, body);
  }

  @Get('orders/me')
  @UseGuards(AuthGuard)
  listMyOrders(@Req() request: RequestWithUser) {
    const user = this.requireUser(request);
    return this.drippybanksService.listMyOrders(user);
  }

  @Get('orders')
  @UseGuards(AuthGuard, AdminGuard)
  listOrdersForAdmin() {
    return this.drippybanksService.listOrdersForAdmin();
  }

  @Get('orders/:id')
  @UseGuards(AuthGuard)
  getOrderById(
    @Req() request: RequestWithUser,
    @Param('id') id: string,
  ) {
    const user = this.requireUser(request);
    return this.drippybanksService.getOrderByIdForUser(user, id);
  }

  @Patch('orders/:id/status')
  @UseGuards(AuthGuard, AdminGuard)
  updateOrderStatus(
    @Req() request: RequestWithUser,
    @Param('id') id: string,
    @Body() body: UpdateOrderStatusInput,
  ) {
    const user = this.requireUser(request);
    const status = body?.status as DrippybanksOrderStatus;
    return this.drippybanksService.updateOrderStatus(user, id, status);
  }

  @Post('payfast/notify')
  @HttpCode(HttpStatus.OK)
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
