import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { AcademyMobileService } from './academy-mobile.service';

@Controller('api/academy/public')
export class AcademyPublicController {
  constructor(private readonly academyMobileService: AcademyMobileService) {}

  @Get('courses')
  listCourses(@Query() query: Record<string, string | undefined>) {
    return this.academyMobileService.listCourses(query);
  }

  @Get('videos')
  listVideos(@Query() query: Record<string, string | undefined>) {
    return this.academyMobileService.listVideos(query);
  }

  @Get('videos/:videoId')
  getVideo(@Param('videoId') videoId: string) {
    return this.academyMobileService.getVideoById(videoId);
  }

  @Get('videos/:videoId/reviews')
  listVideoReviews(@Param('videoId') videoId: string) {
    return this.academyMobileService.listReviews('videos', videoId);
  }
}
