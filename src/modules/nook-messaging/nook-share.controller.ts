import { BadRequestException, Controller, Get, Param, Res } from '@nestjs/common';
import { Response } from 'express';

@Controller('nook/share')
export class NookShareController {
  @Get('posts/:id')
  openPost(@Param('id') id: string, @Res() response: Response) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) {
      throw new BadRequestException('Invalid post link.');
    }
    return response.redirect(302, `nook://post/${encodeURIComponent(id)}`);
  }

  @Get('stories/:id')
  openStory(@Param('id') id: string, @Res() response: Response) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(id)) {
      throw new BadRequestException('Invalid story link.');
    }
    return response.redirect(302, `nook://story/${encodeURIComponent(id)}`);
  }
}
