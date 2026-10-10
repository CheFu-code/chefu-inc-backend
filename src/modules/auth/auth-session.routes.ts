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
import { AuthControllerBase, decodeJwtPayload } from './auth.controller.base';

export abstract class AuthSessionRoutes extends AuthControllerBase {
  @Get('me')
  @UseGuards(AuthGuard)
  async getCurrentUser(@Req() request: Request & { user?: AuthenticatedUser }) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user missing from request.');
    }

    await this.recordServerDetectedCountry(request.user.email, request);
    const profile = await this.getUserProfile(request.user.email);
    const authUser = await this.firebaseAdmin.auth().getUser(request.user.uid);
    const firebasePhone = authUser.phoneNumber || null;
    if (!profile.phone && firebasePhone) {
      profile.phone = firebasePhone;
      await this.firebaseAdmin
        .db()
        .collection('users')
        .doc(request.user.email)
        .set({ phone: firebasePhone }, { merge: true });
    }

    return {
      user: {
        ...request.user,
        displayName: profile.fullname,
        photoURL: profile.profilePicture || null,
        createdAt: profile.createdAt,
        lastLoginAt: profile.lastLoginAt,
      },
      profile,
    };
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: { email?: string; password?: string },
    @Req() request: Request,
  ) {
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '').trim();

    if (!email || !password) {
      throw new BadRequestException('Email and password are required.');
    }

    await this.enforceAuthRateLimit(email, request.ip || 'unknown', 3);

    const apiKey = process.env.FIREBASE_WEB_API_KEY || process.env.FIREBASE_API_KEY;
    if (!apiKey) {
      throw new InternalServerErrorException(
        'Firebase web API key is not configured.',
      );
    }

    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          returnSecureToken: true,
        }),
      },
    );

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => ({}))) as {
        error?: { message?: string; status?: string };
        mfaPendingCredential?: string;
        mfaInfo?: Array<{
          mfaEnrollmentId?: string;
          displayName?: string;
          totpInfo?: Record<string, unknown>;
        }>;
      };
      const upstreamError =
        errorBody.error?.message || errorBody.error?.status || '';
      if (
        errorBody.mfaPendingCredential ||
        upstreamError === 'MFA_REQUIRED'
      ) {
        throw new HttpException(
          {
            statusCode: 409,
            message: 'Multi-factor authentication is required.',
            mfaRequired: true,
            mfaPendingCredential: errorBody.mfaPendingCredential || null,
            mfaInfo: (errorBody.mfaInfo || [])
              .filter(factor => Boolean(factor.totpInfo))
              .map(factor => ({
                mfaEnrollmentId: factor.mfaEnrollmentId || '',
                displayName: factor.displayName || '',
                factorId: 'totp',
              })),
          },
          409,
        );
      }
      throw new UnauthorizedException(
        upstreamError || 'Invalid email or password.',
      );
    }

    const payload = (await response.json().catch(() => null)) as {
      idToken?: string;
      id_token?: string;
      refreshToken?: string;
      refresh_token?: string;
      expiresIn?: string;
      expires_in?: string;
      localId?: string;
      local_id?: string;
      email?: string;
      mfaPendingCredential?: string;
      mfaInfo?: Array<{
        mfaEnrollmentId?: string;
        displayName?: string;
        totpInfo?: Record<string, unknown>;
      }>;
      error?: {
        message?: string;
        status?: string;
      };
    } | null;
    const idToken = payload?.idToken || payload?.id_token;

    if (!idToken) {
      const upstreamError = payload?.error?.message || payload?.error?.status;
      const upstreamErrorCode = upstreamError && /^[A-Z0-9_]+$/.test(upstreamError)
        ? upstreamError
        : null;
      const requiresMfa = Boolean(payload?.mfaPendingCredential);
      if (requiresMfa || upstreamErrorCode === 'MFA_REQUIRED') {
        throw new HttpException(
          {
            statusCode: 409,
            message: 'Multi-factor authentication is required.',
            mfaRequired: true,
            mfaPendingCredential: payload?.mfaPendingCredential || null,
            mfaInfo: (payload?.mfaInfo || [])
              .filter(factor => Boolean(factor.totpInfo && factor.mfaEnrollmentId))
              .map(factor => ({
                mfaEnrollmentId: factor.mfaEnrollmentId || '',
                displayName: factor.displayName || '',
                factorId: 'totp',
              })),
          },
          409,
        );
      }
      this.logger.error(
        JSON.stringify({
          event: 'auth_login_invalid_identity_toolkit_response',
          upstreamStatus: response.status,
          upstreamErrorCode,
          requiresMfa,
          responseFields: payload && typeof payload === 'object'
            ? Object.keys(payload)
            : [],
          hasRefreshToken: Boolean(payload?.refreshToken || payload?.refresh_token),
          hasLocalId: Boolean(payload?.localId || payload?.local_id),
          requestId: request.headers['x-request-id'] || null,
        }),
      );
      throw new BadGatewayException(
        'The authentication service returned an unexpected response. Please try again later.',
      );
    }

    const uid = payload.localId || payload.local_id;
    if (!uid) {
      throw new BadGatewayException(
        'The authentication service returned an unexpected response. Please try again later.',
      );
    }
    const customToken = await this.firebaseAdmin.auth().createCustomToken(uid, {
      chefu_auth_provider: 'password',
    });

    return {
      token: idToken,
      idToken,
      customToken,
      refreshToken: payload.refreshToken || payload.refresh_token || '',
      expiresIn: payload.expiresIn || payload.expires_in || '',
      user: {
        uid,
        email: payload.email || email,
      },
    };
  }

  @Post('session/password')
  @HttpCode(200)
  async createPasswordSession(
    @Body() body: { email?: string; password?: string; trustDevice?: boolean },
    @Headers(CHEFU_APP_HEADER) chefuApp: string | undefined,
    @Headers(FLOW_SESSION_HEADER) flowSession: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const authResult = await this.login(body, request);
    return this.createSession(
      `Bearer ${authResult.idToken}`,
      chefuApp,
      flowSession,
      request,
      response,
      body.trustDevice === true,
    );
  }

  @Post('session/mfa')
  @HttpCode(200)
  async completePasswordMfaSession(
    @Body()
    body: {
      email?: string;
      mfaPendingCredential?: string;
      mfaEnrollmentId?: string;
      verificationCode?: string;
      trustDevice?: boolean;
    },
    @Headers(CHEFU_APP_HEADER) chefuApp: string | undefined,
    @Headers(FLOW_SESSION_HEADER) flowSession: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const email = String(body.email || '').trim().toLowerCase();
    const pendingCredential = String(body.mfaPendingCredential || '');
    const enrollmentId = String(body.mfaEnrollmentId || '');
    const verificationCode = String(body.verificationCode || '').trim();
    if (!isEmail(email) || !pendingCredential || !enrollmentId) {
      throw new BadRequestException('Complete the active MFA sign-in challenge.');
    }
    if (!/^\d{6}$/.test(verificationCode)) {
      throw new BadRequestException('Enter the 6-digit authenticator code.');
    }

    await this.enforceAuthRateLimit(email, request.ip || 'unknown', 3);
    const apiKey = process.env.FIREBASE_WEB_API_KEY || process.env.FIREBASE_API_KEY;
    if (!apiKey) {
      throw new InternalServerErrorException(
        'Firebase web API key is not configured.',
      );
    }
    const mfaResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v2/accounts/mfaSignIn:finalize?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mfaPendingCredential: pendingCredential,
          mfaEnrollmentId: enrollmentId,
          totpVerificationInfo: { verificationCode },
        }),
      },
    );
    const mfaResult = (await mfaResponse.json().catch(() => ({}))) as {
      idToken?: string;
      error?: { message?: string };
    };
    if (!mfaResponse.ok || !mfaResult.idToken) {
      throw new UnauthorizedException('The authenticator code is incorrect or expired.');
    }

    return this.createSession(
      `Bearer ${mfaResult.idToken}`,
      chefuApp,
      flowSession,
      request,
      response,
      body.trustDevice === true,
    );
  }

  @Post('passkey/session/options')
  @HttpCode(200)
  async createPasskeySessionOptions(@Req() request: Request) {
    return this.passkeyService.createAuthenticationOptions(
      this.getClientIp(request) || 'unknown',
    );
  }

  @Post('passkey/session/verify')
  @HttpCode(200)
  async verifyPasskeySession(
    @Body()
    body: {
      challengeId?: string;
      response?: AuthenticationResponseJSON;
      trustDevice?: boolean;
    },
    @Headers(CHEFU_APP_HEADER) chefuApp: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.passkeyService.verifyAuthentication(
      this.getClientIp(request) || 'unknown',
      body,
    );
    const idToken = await this.exchangeCustomTokenForIdToken(result.customToken);
    return this.createSession(
      `Bearer ${idToken}`,
      chefuApp,
      undefined,
      request,
      response,
      body.trustDevice === true,
    );
  }

  @Post('logout')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.clearSessionCookies(response);
    this.logger.log(
      JSON.stringify({
        event: 'auth_logout_called',
        ...auditRequestContext(request),
      }),
    );

    return { ok: true };
  }

  @Post('session')
  async createSession(
    @Headers('authorization') authorization: string | undefined,
    @Headers(CHEFU_APP_HEADER) chefuApp: string | undefined,
    @Headers(FLOW_SESSION_HEADER) flowSession: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    trustDevice = false,
    signupSession = false,
  ) {
    const idToken = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';

    if (!idToken) {
      throw new UnauthorizedException('Missing Firebase ID token.');
    }

    const sessionAppId = this.resolveSessionAppId(chefuApp, flowSession);
    const tokenPayload = decodeJwtPayload(idToken);
    this.logger.log(
      JSON.stringify({
        event: 'auth_session_create_started',
        requestId: request.headers['x-request-id'] || null,
        hasBearerToken: Boolean(idToken),
        tokenAudience: tokenPayload?.aud || null,
        tokenIssuer: tokenPayload?.iss || null,
        signInProvider: tokenPayload?.firebase?.sign_in_provider || null,
        adminProjectId: this.firebaseAdmin.projectId(),
        app: sessionAppId,
        flowSession: isFlowSessionRequest(flowSession),
      }),
    );

    let decodedToken: FirebaseDecodedToken;
    let sessionCookie: string;

    try {
      decodedToken = await this.firebaseAdmin.auth().verifyIdToken(idToken, true);
      this.assertRecentFirebaseSignIn(decodedToken.auth_time);
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'auth_session_create_failed',
          reason: error instanceof Error ? error.message : 'unknown',
          tokenAudience: tokenPayload?.aud || null,
          tokenIssuer: tokenPayload?.iss || null,
          signInProvider: tokenPayload?.firebase?.sign_in_provider || null,
          adminProjectId: this.firebaseAdmin.projectId(),
          app: sessionAppId,
          flowSession: isFlowSessionRequest(flowSession),
        }),
        error instanceof Error ? error.stack : undefined,
      );
      throw new UnauthorizedException('Unable to verify your session. Please sign in again.');
    }

    if (decodedToken.email_verified !== true) {
      throw new ForbiddenException('Please verify your email address before continuing.');
    }

    if (
      sessionAppId === 'flow' &&
      !(await this.isFlowSessionAllowed(decodedToken.email))
    ) {
      this.logger.warn(
        JSON.stringify({
          event: 'flow_session_denied',
          uidHash: hashForAudit(decodedToken.uid),
          emailHash: hashForAudit(decodedToken.email),
          ...auditRequestContext(request),
        }),
      );
      throw new ForbiddenException(FLOW_ACCESS_DENIED_MESSAGE);
    }

    const profileForAccess = await this.getUserProfile(decodedToken.email);
    if (
      sessionAppId === 'admin' &&
      !profileForAccess.roles.some(
        role => role.trim().toLowerCase() === ADMIN_ROLE,
      )
    ) {
      this.clearSessionCookies(response);
      this.logger.warn(
        JSON.stringify({
          event: 'admin_session_denied',
          uidHash: hashForAudit(decodedToken.uid),
          emailHash: hashForAudit(decodedToken.email),
          roles: profileForAccess.roles,
          ...auditRequestContext(request),
        }),
      );
      throw new ForbiddenException('Admin access required.');
    }

    try {
      const expiresIn = SESSION_MAX_AGE_SECONDS * 1000;
      sessionCookie = await this.firebaseAdmin
        .auth()
        .createSessionCookie(idToken, { expiresIn });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'auth_session_create_failed',
          reason: error instanceof Error ? error.message : 'unknown',
          tokenAudience: tokenPayload?.aud || null,
          tokenIssuer: tokenPayload?.iss || null,
          signInProvider: tokenPayload?.firebase?.sign_in_provider || null,
          adminProjectId: this.firebaseAdmin.projectId(),
          app: sessionAppId,
          flowSession: isFlowSessionRequest(flowSession),
        }),
        error instanceof Error ? error.stack : undefined,
      );
      throw new UnauthorizedException('Unable to verify your session. Please sign in again.');
    }

    await this.ensureUserProfile(decodedToken, sessionAppId, request);
    const signupAlertSuppressed = decodedToken.email
      ? await this.consumeSignupSignInAlertSuppression(decodedToken.email)
      : false;
    const isSignupSession = signupSession || signupAlertSuppressed;
    const wasTrustedDevice = await this.isTrustedAuthDevice(decodedToken.uid, request);
    let trustDeviceVerificationRequired = false;
    let trustDeviceResendCooldownSeconds = 0;
    let trustDeviceResendsRemaining = 0;
    let trustDeviceRequiresAuthenticator = false;
    if (
      decodedToken.email &&
      (isSignupSession || (trustDevice && !wasTrustedDevice))
    ) {
      const authUser = await this.firebaseAdmin.auth().getUser(decodedToken.uid);
      const mfaEnabled = (authUser.multiFactor?.enrolledFactors.length || 0) > 0;
      if (
        !signupSession &&
        mfaEnabled &&
        tokenPayload?.firebase?.sign_in_second_factor !== 'totp'
      ) {
        trustDeviceRequiresAuthenticator = true;
      } else if (!signupSession && !mfaEnabled) {
        trustDeviceVerificationRequired = true;
        try {
          const sendResult = await this.issueTrustedDeviceEmailChallenge({
            uid: decodedToken.uid,
            email: decodedToken.email,
            userName: authUser.displayName || decodedToken.name || '',
            request,
            response,
          });
          trustDeviceResendCooldownSeconds = sendResult.cooldownSeconds;
          trustDeviceResendsRemaining = sendResult.resendsRemaining;
        } catch (error) {
          if (!(error instanceof HttpException) || error.getStatus() !== 429) {
            throw error;
          }
          const limit = error.getResponse();
          if (typeof limit === 'object' && limit !== null) {
            const retryAfterSeconds = Reflect.get(limit, 'retryAfterSeconds');
            const resendsRemaining = Reflect.get(limit, 'resendsRemaining');
            trustDeviceResendCooldownSeconds =
              typeof retryAfterSeconds === 'number' ? retryAfterSeconds : 0;
            trustDeviceResendsRemaining =
              typeof resendsRemaining === 'number' ? resendsRemaining : 0;
          }
        }
      } else {
        await this.rememberTrustedAuthDevice({
          uid: decodedToken.uid,
          request,
          response,
          source: isSignupSession ? 'signup' : 'explicit_choice',
        });
      }
    }
    const userProfile = await this.getUserProfile(decodedToken.email);
    const meta = this.buildSessionMeta({
      email: decodedToken.email || '',
      name:
        userProfile.fullname ||
        userProfile.firstName ||
        decodedToken.name ||
        decodedToken.email?.split('@')[0] ||
        '',
      roles: userProfile.roles,
      uid: decodedToken.uid,
    });

    response.cookie(SESSION_COOKIE_NAME, sessionCookie, this.getCookieOptions());
    response.cookie(
      SESSION_META_COOKIE_NAME,
      this.sessionSigner.sign(meta),
      this.getCookieOptions(),
    );

    this.logger.log(
      JSON.stringify({
        event: 'auth_session_created',
        uidHash: hashForAudit(decodedToken.uid),
        emailHash: hashForAudit(decodedToken.email),
        app: sessionAppId,
        roleCount: userProfile.roles.length,
        ...auditRequestContext(request),
      }),
    );

    const signInProvider =
      tokenPayload?.chefu_auth_provider ||
      tokenPayload?.firebase?.sign_in_provider;
    if (
      decodedToken.email &&
      !isSignupSession &&
      !wasTrustedDevice &&
      signInProvider &&
      userProfile.securityEmailsEnabled
    ) {
      void this.sendThrottledSignInNotification({
        email: decodedToken.email,
        uid: decodedToken.uid,
        userName: meta.name,
        provider: signInProvider,
        request,
        appId: sessionAppId,
      });
    }

    return {
      ok: true,
      app: sessionAppId,
      trustDeviceVerificationRequired,
      trustDeviceResendCooldownSeconds,
      trustDeviceResendsRemaining,
      trustDeviceRequiresAuthenticator,
    };
  }

  @Post('mfa/backup-code/session')
  async createBackupCodeRecoverySession(
    @Body()
    body: {
      email?: string;
      code?: string;
      mfaPendingCredential?: string;
    },
    @Req() request: Request,
  ) {
    const email = String(body.email || '').trim().toLowerCase();
    await this.enforceAuthRateLimit(email, request.ip || 'unknown');

    return this.mfaBackupCodes.consumeBackupCode({
      email: body.email,
      code: body.code,
      mfaPendingCredential: body.mfaPendingCredential,
      ip: request.ip,
    });
  }

  @Post('mfa/backup-codes')
  @UseGuards(AuthGuard)
  async generateBackupCodes(
    @Req() request: Request & { user?: AuthenticatedUser },
  ) {
    return this.mfaBackupCodes.generateBackupCodes({
      email: request.user?.email,
      uid: request.user?.uid,
    });
  }

  @Delete('session')
  @HttpCode(200)
  async clearSession(
    @Query('global') globalLogout: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const revokeGlobally =
      globalLogout === 'true' || globalLogout === '1' || globalLogout === 'yes';
    let revocation = { revoked: false, uidHash: null as string | null, emailHash: null as string | null };
    let revocationError: unknown;

    try {
      if (revokeGlobally) {
        revocation = await this.revokeCurrentSession(request);
      }
    } catch (error) {
      revocationError = error;
      this.logger.error(
        JSON.stringify({
          event: 'auth_global_logout_failed',
          reason: error instanceof Error ? error.message : 'unknown',
          ...auditRequestContext(request),
        }),
      );
    } finally {
      await this.recordSignedOutActivity(
        request,
        revokeGlobally ? 'sessions_revoked' : 'signed_out',
      );
      this.clearSessionCookies(response);
      this.logger.log(
        JSON.stringify({
          event: 'auth_session_cleared',
          global: revokeGlobally,
          revoked: revocation.revoked,
          uidHash: revocation.uidHash,
          emailHash: revocation.emailHash,
          ...auditRequestContext(request),
        }),
      );
    }

    if (revokeGlobally && (revocationError || !revocation.revoked)) {
      throw new ServiceUnavailableException(
        'This browser session was cleared, but global sign-out could not be confirmed. Please try again.',
      );
    }

    return { ok: true, revoked: revocation.revoked };
  }

}
