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
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CloudenceUploadGuard } from './cloudence-upload.guard';

type RequestWithUser = Request & { user?: AuthenticatedUser };

@Controller('cloudence/files')
@UseGuards(AuthGuard)
export class CloudenceController {
  constructor(private readonly cloudence: CloudenceService) {}

  @Post()
  @UseGuards(CloudenceUploadGuard)
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
    @Body('folderId') folderId?: string,
  ) {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException('No file received. Send a multipart/form-data request with a "file" field.');
    }
    const name = nameOverride || file.originalname || 'unnamed';
    return this.cloudence.upload(this.requireUser(request), file.buffer, name, file.mimetype, folderId);
  }

  @Get()
  list(
    @Req() request: RequestWithUser,
    @Query('type') type?: string,
    @Query('types') types?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: string,
    @Query('limit') limit?: string,
    @Query('section') section?: string,
    @Query('folder') folderId?: string,
    @Query('offset') offset?: string,
  ) {
    return this.cloudence.list(this.requireUser(request), {
      type,
      types,
      search,
      sort,
      limit: limit ? Number(limit) : undefined,
      section, folderId, offset: offset ? Number(offset) : undefined,
    });
  }

  @Post('folders')
  createFolder(@Req() request: RequestWithUser, @Body() body: { section?: string; name?: string }) {
    return this.cloudence.folders.save(this.requireUser(request), { section: body.section, name: body.name });
  }

  @Patch('folders/:id')
  renameFolder(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: { name?: string }) {
    return this.cloudence.folders.save(this.requireUser(request), { id, name: body.name });
  }

  @Delete('folders/:id')
  deleteFolder(@Req() request: RequestWithUser, @Param('id') id: string) {
    return this.cloudence.folders.save(this.requireUser(request), { id, remove: true });
  }

  @Patch(':id/folder')
  moveToFolder(@Req() request: RequestWithUser, @Param('id') id: string, @Body() body: { folderId?: string | null }) {
    return this.cloudence.folders.move(this.requireUser(request), id, body.folderId);
  }

  @Get('usage')
  usage(@Req() request: RequestWithUser) {
    return this.cloudence.usage(this.requireUser(request));
  }


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
    if (json === 'true') {
      const result = await this.cloudence.getDownloadUrl(this.requireUser(request), id);
      return res?.json(result);
    }
    return this.content(request, id, '1', undefined, res!);
  }

  @Get(':id/content')
  async content(
    @Req() request: RequestWithUser,
    @Param('id') id: string,
    @Query('download') download: string | undefined,
    @Query('preview') preview: string | undefined,
    @Res() response: Response,
  ) {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    response.vary('Cookie, Authorization');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
    const controller = new AbortController();
    const abort = () => controller.abort();
    response.once('close', abort);
    try {
      const { file, upstream } = await this.cloudence.openContent(this.requireUser(request), id, {
        range: request.headers.range, preview: preview === '1', signal: controller.signal,
      });
      response.status(upstream.status);
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(name);
        if (name === 'content-length' && upstream.headers.has('content-encoding')) continue;
        if (value) response.setHeader(name, value);
      }
      const activeContent = /(?:html|svg|xml|javascript)/i.test(upstream.headers.get('content-type') || '');
      response.setHeader('Content-Disposition', `${download === '1' || activeContent ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}`);
      if (request.method === 'HEAD' || !upstream.body || upstream.status === 416) {
        await upstream.body?.cancel();
        response.end();
        return;
      }
      await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), response);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (response.headersSent) { response.destroy(error instanceof Error ? error : undefined); return; }
      throw error;
    } finally { response.removeListener('close', abort); }
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

