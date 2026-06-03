import {
  Body,
  Controller,
  Post,
  Get,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { AuthGuard } from '../auth/auth.guard';
import { MuzaloService } from './muzalo.service';

type RequestWithUser = Request & {
  user?: AuthenticatedUser;
};

@Controller('muzalo')
export class MuzaloController {
  constructor(private readonly muzaloService: MuzaloService) {}

  @Get('catalog')
  async catalog() {
    return this.muzaloService.getCatalog();
  }

  @Get('profile')
  @UseGuards(AuthGuard)
  async profile(@Req() request: RequestWithUser) {
    const user = this.requireUser(request);
    return this.muzaloService.getProfile(user);
  }

  @Post('artist-profile-request')
  @UseGuards(AuthGuard)
  async requestArtistProfile(
    @Req() request: RequestWithUser,
    @Body()
    body: {
      artistName?: string;
      message?: string;
      primaryGenre?: string;
      spotifyUrl?: string;
      websiteUrl?: string;
    },
  ) {
    const user = this.requireUser(request);
    return this.muzaloService.requestArtistProfile(user, body);
  }

  private requireUser(request: RequestWithUser) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user missing from request.');
    }

    return request.user;
  }
}
