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

  @Post('courses')
  createCourse(
    @Req() request: AcademyMobileRequest,
    @Body() body: unknown,
  ) {
    return this.academyMobileService.createCourse(
      this.requireUser(request),
      body,
    );
  }

  @Post('courses/:courseId/enroll')
  @HttpCode(200)
  enrollCourse(
    @Req() request: AcademyMobileRequest,
    @Param('courseId') courseId: string,
  ) {
    return this.academyMobileService.enrollCourse(
      this.requireUser(request),
      courseId,
    );
  }

  @Get('courses/:courseId')
  getCourse(
    @Req() request: AcademyMobileRequest,
    @Param('courseId') courseId: string,
  ) {
    return this.academyMobileService.getCourseById(
      courseId,
      this.requireUser(request),
    );
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

  @Post('videos/:videoId/enroll')
  @HttpCode(200)
  enrollVideo(
    @Req() request: AcademyMobileRequest,
    @Param('videoId') videoId: string,
  ) {
    return this.academyMobileService.enrollVideo(
      this.requireUser(request),
      videoId,
    );
  }

  @Get('videos/:videoId/enrollment')
  getVideoEnrollment(
    @Req() request: AcademyMobileRequest,
    @Param('videoId') videoId: string,
  ) {
    return this.academyMobileService.getVideoEnrollment(
      this.requireUser(request),
      videoId,
    );
  }

  @Post('videos/upload-urls')
  createVideoUploadUrls(
    @Req() request: AcademyMobileRequest,
    @Body() body: unknown,
  ) {
    return this.academyMobileService.createVideoUploadUrls(
      this.requireUser(request),
      body,
    );
  }

  @Post('videos/upload-urls/:uploadId/complete')
  completeVideoUpload(
    @Req() request: AcademyMobileRequest,
    @Param('uploadId') uploadId: string,
    @Body() body: unknown,
  ) {
    return this.academyMobileService.completeVideoUpload(
      this.requireUser(request),
      uploadId,
      body,
    );
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

  @Get('videos/:videoId/reviews')
  listVideoReviews(@Param('videoId') videoId: string) {
    return this.academyMobileService.listReviews('videos', videoId);
  }

  @Post('videos/:videoId/reviews')
  createVideoReview(
    @Req() request: AcademyMobileRequest,
    @Param('videoId') videoId: string,
    @Body() body: unknown,
  ) {
    return this.academyMobileService.createReview(
      this.requireUser(request),
      'videos',
      videoId,
      body,
    );
  }

  @Patch('videos/:videoId/reviews/:reviewId')
  updateVideoReview(
    @Req() request: AcademyMobileRequest,
    @Param('videoId') videoId: string,
    @Param('reviewId') reviewId: string,
    @Body() body: unknown,
  ) {
    return this.academyMobileService.updateReview(
      this.requireUser(request),
      'videos',
      videoId,
      reviewId,
      body,
    );
  }

  @Delete('videos/:videoId/reviews/:reviewId')
  deleteVideoReview(
    @Req() request: AcademyMobileRequest,
    @Param('videoId') videoId: string,
    @Param('reviewId') reviewId: string,
  ) {
    return this.academyMobileService.deleteReview(
      this.requireUser(request),
      'videos',
      videoId,
      reviewId,
    );
  }

  @Get('courses/:courseId/reviews/:reviewId')
  getCourseReview(
    @Req() request: AcademyMobileRequest,
    @Param('courseId') courseId: string,
    @Param('reviewId') reviewId: string,
  ) {
    return this.academyMobileService.getCourseReview(
      this.requireUser(request),
      courseId,
      reviewId,
    );
  }

  @Put('courses/:courseId/reviews')
  saveCourseReview(
    @Req() request: AcademyMobileRequest,
    @Param('courseId') courseId: string,
    @Body() body: unknown,
  ) {
    return this.academyMobileService.saveCourseReview(
      this.requireUser(request),
      courseId,
      body,
    );
  }

  @Post('feedback')
  createFeedback(
    @Req() request: AcademyMobileRequest,
    @Body() body: unknown,
  ) {
    return this.academyMobileService.createFeedback(
      this.requireUser(request),
      body,
    );
  }

  @Get('support-tickets')
  listSupportTickets(
    @Req() request: AcademyMobileRequest,
    @Query('scope') scope?: string,
  ) {
    return this.academyMobileService.listSupportTickets(
      this.requireUser(request),
      scope,
    );
  }

  @Post('support-tickets')
  createSupportTicket(
    @Req() request: AcademyMobileRequest,
    @Body() body: unknown,
  ) {
    return this.academyMobileService.createSupportTicket(
      this.requireUser(request),
      body,
    );
  }

  @Get('support-tickets/:ticketId')
  getSupportTicket(
    @Req() request: AcademyMobileRequest,
    @Param('ticketId') ticketId: string,
  ) {
    return this.academyMobileService.getSupportTicket(
      this.requireUser(request),
      ticketId,
    );
  }

  @Post('support-tickets/:ticketId/replies')
  replyToSupportTicket(
    @Req() request: AcademyMobileRequest,
    @Param('ticketId') ticketId: string,
    @Body() body: unknown,
  ) {
    return this.academyMobileService.replyToSupportTicket(
      this.requireUser(request),
      ticketId,
      body,
    );
  }

  @Get('admin/users')
  listAdminUsers(@Req() request: AcademyMobileRequest) {
    return this.academyMobileService.listAdminUsers(
      this.requireUser(request),
    );
  }

  @Patch('admin/users/roles')
  updateAdminUserRoles(
    @Req() request: AcademyMobileRequest,
    @Body() body: unknown,
  ) {
    return this.academyMobileService.updateAdminUserRoles(
      this.requireUser(request),
      body,
    );
  }

  @Delete('admin/users/:email')
  deleteAdminUser(
    @Req() request: AcademyMobileRequest,
    @Param('email') email: string,
  ) {
    return this.academyMobileService.deleteAdminUser(
      this.requireUser(request),
      email,
    );
  }

  @Get('admin/reports')
  listAdminReports(@Req() request: AcademyMobileRequest) {
    return this.academyMobileService.listAdminReports(
      this.requireUser(request),
    );
  }

  @Get('admin/metrics')
  getAdminMetrics(@Req() request: AcademyMobileRequest) {
    return this.academyMobileService.getAdminMetrics(
      this.requireUser(request),
    );
  }

  @Get('admin/user-activity')
  getAdminUserActivity(@Req() request: AcademyMobileRequest) {
    return this.academyMobileService.getAdminUserActivity(
      this.requireUser(request),
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
