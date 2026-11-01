import {
    Body,
    Delete,
    Get,
    Post,
    Req,
    UnauthorizedException,
    UseGuards
} from '@nestjs/common';
import { Request } from 'express';
import { AuthOnboardingRoutes } from './auth-onboarding.routes';
import { AuthGuard } from './auth.guard';
import { AuthenticatedUser } from './authenticated-user';

export abstract class AuthProfilePictureRoutes extends AuthOnboardingRoutes {
  @Post('profile-picture')
  @UseGuards(AuthGuard)
  async uploadProfilePicture(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Body() body: { imageBase64: string; contentType?: string },
  ) {
    const user = request.user;
    if (!user) {
      throw new UnauthorizedException('User not authenticated.');
    }
    return this.profilePictureService.uploadProfilePicture(user, body);
  }

  @Get('profile-picture')
  @UseGuards(AuthGuard)
  async getProfilePicture(
    @Req() request: Request & { user?: AuthenticatedUser },
  ) {
    const user = request.user;
    if (!user) {
      throw new UnauthorizedException('User not authenticated.');
    }
    return this.profilePictureService.getProfilePicture(user);
  }

  @Delete('profile-picture')
  @UseGuards(AuthGuard)
  async deleteProfilePicture(
    @Req() request: Request & { user?: AuthenticatedUser },
  ) {
    const user = request.user;
    if (!user) {
      throw new UnauthorizedException('User not authenticated.');
    }
    await this.profilePictureService.deleteProfilePicture(user);
    return { message: 'Profile picture deleted successfully.' };
  }

}
