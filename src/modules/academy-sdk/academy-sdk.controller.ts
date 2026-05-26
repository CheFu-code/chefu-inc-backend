import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { AcademySdkApiKeyGuard } from './academy-sdk-api-key.guard';
import { AcademySdkService } from './academy-sdk.service';
import { AcademySdkRequest } from './academy-sdk.types';

type KeyBody = {
  name?: string;
  keyId?: string;
};

type LeakReportBody = {
  apiKey?: string;
  leakedKey?: string;
  source?: string;
  url?: string;
  repository?: string;
  commit?: string;
};

type ListQuery = {
  query?: string;
  category?: string;
  limit?: string;
};

type RequestWithUser = Request & {
  user?: AuthenticatedUser;
};

@Controller('api')
export class AcademySdkApiController {
  constructor(private readonly academySdkService: AcademySdkService) {}

  @Post('auth/verify')
  @HttpCode(200)
  @UseGuards(AcademySdkApiKeyGuard)
  verifyApiKey(@Req() request: AcademySdkRequest) {
    return this.academySdkService.verifyApiKey(request.apiKey);
  }

  @Post('courses/list')
  @HttpCode(200)
  @UseGuards(AcademySdkApiKeyGuard)
  listCoursesPost(@Body() body: ListQuery) {
    return this.academySdkService.listCourses(body);
  }

  @Get('courses')
  @UseGuards(AcademySdkApiKeyGuard)
  listCourses(@Query() query: ListQuery) {
    return this.academySdkService.listCourses(query);
  }

  @Get('courses/search')
  @UseGuards(AcademySdkApiKeyGuard)
  searchCourses(@Query() query: ListQuery) {
    return this.academySdkService.searchCourses(query);
  }

  @Get('courses/featured')
  @UseGuards(AcademySdkApiKeyGuard)
  getFeaturedCourses(@Query() query: Pick<ListQuery, 'limit'>) {
    return this.academySdkService.getFeaturedCourses(query);
  }

  @Get('courses/categories')
  @UseGuards(AcademySdkApiKeyGuard)
  getCourseCategories() {
    return this.academySdkService.getCourseCategories();
  }

  @Get('courses/:courseId')
  @UseGuards(AcademySdkApiKeyGuard)
  getCourse(@Param('courseId') courseId: string) {
    return this.academySdkService.getCourseById(courseId);
  }

  @Get('courses/:courseId/chapters')
  @UseGuards(AcademySdkApiKeyGuard)
  getCourseChapters(@Param('courseId') courseId: string) {
    return this.academySdkService.getCourseChapters(courseId);
  }

  @Get('courses/:courseId/chapters/:chapterIndex')
  @UseGuards(AcademySdkApiKeyGuard)
  getCourseChapter(
    @Param('courseId') courseId: string,
    @Param('chapterIndex') chapterIndex: string,
  ) {
    return this.academySdkService.getCourseChapter(
      courseId,
      Number(chapterIndex),
    );
  }

  @Get('courses/:courseId/chapters/:chapterIndex/lessons')
  @UseGuards(AcademySdkApiKeyGuard)
  getCourseLessons(
    @Param('courseId') courseId: string,
    @Param('chapterIndex') chapterIndex: string,
  ) {
    return this.academySdkService.getCourseLessons(
      courseId,
      Number(chapterIndex),
    );
  }

  @Get('courses/:courseId/quiz')
  @UseGuards(AcademySdkApiKeyGuard)
  getCourseQuiz(@Param('courseId') courseId: string) {
    return this.academySdkService.getCourseQuiz(courseId);
  }

  @Get('courses/:courseId/flashcards')
  @UseGuards(AcademySdkApiKeyGuard)
  getCourseFlashcards(@Param('courseId') courseId: string) {
    return this.academySdkService.getCourseFlashcards(courseId);
  }

  @Get('courses/:courseId/qa')
  @UseGuards(AcademySdkApiKeyGuard)
  getCourseQA(@Param('courseId') courseId: string) {
    return this.academySdkService.getCourseQA(courseId);
  }

  @Get('videos')
  @UseGuards(AcademySdkApiKeyGuard)
  listVideos(@Query() query: ListQuery) {
    return this.academySdkService.listVideos(query);
  }

  @Get('videos/search')
  @UseGuards(AcademySdkApiKeyGuard)
  searchVideos(@Query() query: ListQuery) {
    return this.academySdkService.searchVideos(query);
  }

  @Get('videos/category/:category')
  @UseGuards(AcademySdkApiKeyGuard)
  getVideosByCategory(@Param('category') category: string) {
    return this.academySdkService.listVideos({ category });
  }

  @Get('videos/:videoId')
  @UseGuards(AcademySdkApiKeyGuard)
  getVideo(@Param('videoId') videoId: string) {
    return this.academySdkService.getVideoById(videoId);
  }
}

@Controller()
export class AcademySdkAuthController {
  constructor(private readonly academySdkService: AcademySdkService) {}

  @Post('api/auth/login')
  @HttpCode(200)
  login(@Body() body: { email?: string; password?: string }) {
    return this.academySdkService.login(body);
  }

  @Post('auth/login')
  @HttpCode(200)
  loginRoot(@Body() body: { email?: string; password?: string }) {
    return this.academySdkService.login(body);
  }

  @Post('api/auth/register')
  register(
    @Body() body: { email?: string; password?: string; fullname?: string },
  ) {
    return this.academySdkService.register(body);
  }

  @Post('auth/register')
  registerRoot(
    @Body() body: { email?: string; password?: string; fullname?: string },
  ) {
    return this.academySdkService.register(body);
  }

  @Post('api/auth/refresh')
  @HttpCode(200)
  refresh(@Body() body: { refreshToken?: string }) {
    return this.academySdkService.refreshSession(body);
  }

  @Post('auth/refresh')
  @HttpCode(200)
  refreshRoot(@Body() body: { refreshToken?: string }) {
    return this.academySdkService.refreshSession(body);
  }
}

@Controller('api/keys')
export class AcademySdkSecurityController {
  constructor(private readonly academySdkService: AcademySdkService) {}

  @Post('report-leak')
  @HttpCode(202)
  reportLeakedKey(@Req() request: Request, @Body() body: LeakReportBody) {
    return this.academySdkService.reportLeakedApiKey(body, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
  }
}

@Controller('api/keys')
@UseGuards(AuthGuard)
export class AcademySdkKeysController {
  constructor(private readonly academySdkService: AcademySdkService) {}

  @Post('create')
  @HttpCode(200)
  create(@Req() request: RequestWithUser, @Body() body: KeyBody) {
    return this.academySdkService.createApiKey(
      this.requireUser(request),
      body.name,
    );
  }

  @Get('list')
  list(@Req() request: RequestWithUser) {
    return this.academySdkService.listApiKeys(this.requireUser(request));
  }

  @Post('revoke')
  @HttpCode(200)
  revoke(@Req() request: RequestWithUser, @Body() body: KeyBody) {
    return this.academySdkService.revokeApiKey(
      this.requireUser(request),
      body.keyId,
    );
  }

  private requireUser(request: RequestWithUser) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user missing from request.');
    }

    return {
      uid: request.user.uid,
      email: request.user.email,
      roles: request.user.roles,
    };
  }
}
