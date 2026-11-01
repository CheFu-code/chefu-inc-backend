import {
  Body,
  Controller,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { SubmissionsService } from './submissions.service';
import { getClientIp } from '../../common/security-audit';

type RequestWithUser = Request & { user?: AuthenticatedUser };

@Controller('submissions')
export class SubmissionsController {
  constructor(private readonly submissions: SubmissionsService) {}

  @Post('contact')
  @UseGuards(AuthGuard)
  submitContact(@Req() request: RequestWithUser, @Body() body: Record<string, unknown>) {
    if (!request.user) throw new UnauthorizedException('Authenticated user missing from request.');
    return this.submissions.submitContact(request.user, body);
  }

  @Post('careers')
  submitCareer(@Req() request: Request, @Body() body: Record<string, unknown>) {
    return this.submissions.submitCareer(body, getClientIp(request));
  }
}