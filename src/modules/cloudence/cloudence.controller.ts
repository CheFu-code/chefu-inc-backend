import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CloudenceService } from './cloudence.service';
import { UpdateCloudenceFileInput, UploadCloudenceFileInput } from './cloudence.types';

type RequestWithUser = Request & { user?: AuthenticatedUser };

@Controller('cloudence/files')
@UseGuards(AuthGuard)
export class CloudenceController {
  constructor(private readonly cloudence: CloudenceService) {}

  @Post()
  upload(@Req() request: RequestWithUser, @Body() body: UploadCloudenceFileInput) {
    return this.cloudence.upload(this.requireUser(request), body);
  }

  @Get()
  list(
    @Req() request: RequestWithUser,
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: string,
    @Query('limit') limit?: string,
  ) {
    return this.cloudence.list(this.requireUser(request), {
      type,
      search,
      sort,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('usage')
  usage(@Req() request: RequestWithUser) {
    return this.cloudence.usage(this.requireUser(request));
  }

  @Patch(':id')
  update(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: UpdateCloudenceFileInput) {
    return this.cloudence.update(this.requireUser(request), id, body);
  }

  @Delete(':id')
  remove(@Req() request: RequestWithUser, @Param('id') id: string) {
    return this.cloudence.remove(this.requireUser(request), id);
  }

  private requireUser(request: RequestWithUser) {
    if (!request.user) throw new UnauthorizedException('Authenticated user missing from request.');
    return request.user;
  }
}
