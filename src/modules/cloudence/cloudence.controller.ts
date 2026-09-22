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
  Res,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { CloudenceService } from './cloudence.service';
import { UpdateCloudenceFileInput } from './cloudence.types';

type RequestWithUser = Request & { user?: AuthenticatedUser };

@Controller('cloudence/files')
@UseGuards(AuthGuard)
export class CloudenceController {
  constructor(private readonly cloudence: CloudenceService) {}

  /**
   * Accepts multipart/form-data with a field named "file".
   * Using memoryStorage so the buffer is available directly without disk I/O.
   * All security checks (magic bytes, DLP, EXIF strip, quota) run in the service
   * on the raw Buffer — no base64 overhead at any stage.
   */
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 55 * 1024 * 1024 }, // 55 MB hard cap (service enforces per-type limits)
    }),
  )
  upload(
    @Req() request: RequestWithUser,
    @UploadedFile() file: Express.Multer.File,
    @Body('name') nameOverride?: string,
  ) {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException('No file received. Send a multipart/form-data request with a "file" field.');
    }
    const name = nameOverride || file.originalname || 'unnamed';
    return this.cloudence.upload(this.requireUser(request), file.buffer, name, file.mimetype);
  }

  @Get()
  list(
    @Req() request: RequestWithUser,
    @Query('type') type?: string,
    @Query('types') types?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: string,
    @Query('limit') limit?: string,
  ) {
    return this.cloudence.list(this.requireUser(request), {
      type,
      types,
      search,
      sort,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('usage')
  usage(@Req() request: RequestWithUser) {
    return this.cloudence.usage(this.requireUser(request));
  }

  /**
   * Combined dashboard endpoint: returns recent files + quota in one round-trip.
   * Replaces the two parallel fetches (getFiles + getTotalSpaceUsed) on the dashboard page.
   */
  @Get('dashboard')
  dashboard(@Req() request: RequestWithUser) {
    return this.cloudence.dashboard(this.requireUser(request));
  }

  @Patch(':id')
  update(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: UpdateCloudenceFileInput) {
    return this.cloudence.update(this.requireUser(request), id, body);
  }

  @Get(':id/download')
  async download(
    @Req() request: RequestWithUser,
    @Param('id') id: string,
    @Query('json') json?: string,
    @Res() res?: Response,
  ) {
    const result = await this.cloudence.getDownloadUrl(this.requireUser(request), id);
    if (json === 'true') {
      return res?.json(result);
    }
    return res?.redirect(result.downloadUrl);
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

