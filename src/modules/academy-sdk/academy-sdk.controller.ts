import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
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
  listCoursesPost() {
    return this.academySdkService.listCourses();
  }

  @Get('courses')
  @UseGuards(AcademySdkApiKeyGuard)
  listCourses() {
    return this.academySdkService.listCourses();
  }

  @Get('courses/:courseId')
  @UseGuards(AcademySdkApiKeyGuard)
  getCourse(@Param('courseId') courseId: string) {
    return this.academySdkService.getCourseById(courseId);
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
    };
  }
}
