import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { AcademyMobileService } from './academy-mobile.service';

type AcademyMobileRequest = Request & {
  user?: AuthenticatedUser;
};

@Controller('api/academy/mobile')
@UseGuards(AuthGuard)
export class AcademyMobileController {
  constructor(private readonly academyMobileService: AcademyMobileService) {}

  @Get('me')
  getProfile(@Req() request: AcademyMobileRequest) {
    return this.academyMobileService.getProfile(this.requireUser(request));
  }

  @Patch('me')
  updateProfile(
    @Req() request: AcademyMobileRequest,
    @Body() body: unknown,
  ) {
    return this.academyMobileService.updateProfile(
      this.requireUser(request),
      body,
    );
  }

  @Get('me/export')
  exportProfile(@Req() request: AcademyMobileRequest) {
    return this.academyMobileService.exportProfile(this.requireUser(request));
  }

  @Get('settings')
  getSettings(@Req() request: AcademyMobileRequest) {
    return this.academyMobileService.getSettings(this.requireUser(request));
  }

  @Patch('settings')
  updateSettings(
    @Req() request: AcademyMobileRequest,
    @Body() body: unknown,
  ) {
    return this.academyMobileService.updateSettings(
      this.requireUser(request),
      body,
    );
  }

  @Put('permissions')
  updatePermissions(
    @Req() request: AcademyMobileRequest,
    @Body() body: unknown,
  ) {
    return this.academyMobileService.updatePermissions(
      this.requireUser(request),
      body,
    );
  }

  @Post('presence')
  @HttpCode(200)
  updatePresence(
    @Req() request: AcademyMobileRequest,
    @Body() body: unknown,
  ) {
    return this.academyMobileService.updatePresence(
      this.requireUser(request),
      body,
    );
  }

  @Get('courses/my')
  listMyCourses(
    @Req() request: AcademyMobileRequest,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.academyMobileService.listMyCourses(
      this.requireUser(request),
      query,
    );
  }

  @Get('courses')
  listCourses(@Query() query: Record<string, string | undefined>) {
    return this.academyMobileService.listCourses(query);
  }

  @Get('courses/:courseId')
  getCourse(@Param('courseId') courseId: string) {
    return this.academyMobileService.getCourseById(courseId);
  }

  @Get('videos')
  listVideos(@Query() query: Record<string, string | undefined>) {
    return this.academyMobileService.listVideos(query);
  }

  @Get('videos/youtube/lookup')
  lookupYouTubeVideo(@Query() query: Record<string, string | undefined>) {
    return this.academyMobileService.lookupYouTubeVideo(query);
  }

  @Get('videos/:videoId')
  getVideo(@Param('videoId') videoId: string) {
    return this.academyMobileService.getVideoById(videoId);
  }

  @Delete('videos/:videoId')
  @HttpCode(200)
  deleteVideo(
    @Req() request: AcademyMobileRequest,
    @Param('videoId') videoId: string,
  ) {
    return this.academyMobileService.deleteVideo(
      this.requireUser(request),
      videoId,
    );
  }

  @Post('notifications/fcm-token')
  @HttpCode(200)
  saveFcmToken(
    @Req() request: AcademyMobileRequest,
    @Body() body: unknown,
  ) {
    return this.academyMobileService.saveFcmToken(
      this.requireUser(request),
      body,
    );
  }

  @Post('notifications/send')
  @HttpCode(200)
  sendNotification(
    @Req() request: AcademyMobileRequest,
    @Body() body: unknown,
  ) {
    return this.academyMobileService.sendNotification(
      this.requireUser(request),
      body,
    );
  }

  @Post('avatar')
  @HttpCode(200)
  uploadAvatar(
    @Req() request: AcademyMobileRequest,
    @Body() body: unknown,
  ) {
    return this.academyMobileService.uploadAvatar(
      this.requireUser(request),
      body,
    );
  }

  private requireUser(request: AcademyMobileRequest) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user missing from request.');
    }

    return request.user;
  }
}
