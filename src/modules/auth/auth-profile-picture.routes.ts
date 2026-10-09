import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  InternalServerErrorException,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import isEmail from 'validator/lib/isEmail';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { RuntimeLimitService } from '../../common/runtime-limit.service';
import { auditRequestContext, hashForAudit } from '../../common/security-audit';
import { AppsService } from '../apps/apps.service';
import { CHEFU_APP_HEADER, ChefuAppId } from '../apps/app-registry';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { AuthenticatedUser } from './authenticated-user';
import { AdminGuard } from './admin.guard';
import { AuthGuard } from './auth.guard';
import { ADMIN_ROLE } from './roles';
import {
  SESSION_META_AUDIENCE,
  SESSION_META_ISSUER,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  SESSION_META_COOKIE_NAME,
  SessionMeta,
} from './session.constants';
import { MfaBackupCodeService } from './mfa-backup-code.service';
import {
  AccountSecurityActivityType,
  SecurityEventsService,
} from './security-events.service';
import { SessionSignerService } from './session-signer.service';
import { ProfilePictureService } from './profile-picture.service';
import { PasskeyService } from './passkey.service';
import { ResendService } from '../email/resend.service';
import {
  FLOW_ACCESS_DENIED_MESSAGE,
  FLOW_SESSION_HEADER,
  isFlowAllowedEmail,
  isFlowSessionRequest,
  normalizeEmailAddress,
} from '../flow/flow-access';
import {
  buildDeviceAuthChallenge,
  isDeviceAuthExpired,
  normalizeDeviceCode,
} from './device-auth';
import { FirebaseDecodedToken, ProfileUpdateBody,AcademyProfileUpdate,ProfilePictureUpdate,SignInAlertDecision } from './auth-controller.types';
import { AuthOnboardingRoutes } from './auth-onboarding.routes';

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
