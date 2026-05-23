import {
  Body,
  Controller,
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
import { CoursesService } from './courses.service';

type CourseRequest = Request & {
  user?: AuthenticatedUser;
};

type ResumeBody = {
  chapterIndex?: number;
  contentIndex?: number;
};

type CompleteBody = {
  chapterIndex?: number;
};

@Controller('courses')
@UseGuards(AuthGuard)
export class CoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  @Get(':courseId/learning')
  getLearningCourse(
    @Req() request: CourseRequest,
    @Param('courseId') courseId: string,
    @Query('chapter') chapter = '0',
  ) {
    return this.coursesService.getLearningCourse(
      this.requireUser(request),
      courseId,
      Number(chapter),
    );
  }

  @Patch(':courseId/resume')
  saveResume(
    @Req() request: CourseRequest,
    @Param('courseId') courseId: string,
    @Body() body: ResumeBody,
  ) {
    return this.coursesService.saveResume(
      this.requireUser(request),
      courseId,
      Number(body.chapterIndex),
      Number(body.contentIndex),
    );
  }

  @Post(':courseId/complete-chapter')
  completeChapter(
    @Req() request: CourseRequest,
    @Param('courseId') courseId: string,
    @Body() body: CompleteBody,
  ) {
    return this.coursesService.completeChapter(
      this.requireUser(request),
      courseId,
      Number(body.chapterIndex),
    );
  }

  private requireUser(request: CourseRequest) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user missing from request.');
    }

    return request.user;
  }
}
