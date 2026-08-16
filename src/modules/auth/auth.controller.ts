import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  InternalServerErrorException,
  Logger,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
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
import { SecurityEventsService } from './security-events.service';
import { SessionSignerService } from './session-signer.service';
import { ResendService } from '../email/resend.service';
import {
  FLOW_ACCESS_DENIED_MESSAGE,
  FLOW_SESSION_HEADER,
  isFlowAllowedEmail,
  isFlowSessionRequest,
} from '../flow/flow-access';

function decodeJwtPayload(token: string) {
  const [, payload] = token.split('.');
  if (!payload) return null;

  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      aud?: string;
      iss?: string;
      sub?: string;
      auth_time?: number;
      iat?: number;
      exp?: number;
      picture?: string;
      firebase?: {
        sign_in_provider?: string;
      };
    };
  } catch {
    return null;
  }
}

type FirebaseDecodedToken = Awaited<
  ReturnType<ReturnType<FirebaseAdminService['auth']>['verifyIdToken']>
>;

type AcademyProfileUpdate = {
  bio?: string;
  country?: string;
  countryCode?: string;
  language?: string;
  learningGoal?: string;
  skillLevel?: string;
  learningInterests?: string[];
  weeklyLearningGoal?: number;
  lessonStyle?: string;
  defaultCourseDifficulty?: string;
  preferredContentFormat?: string;
  aiTutorSuggestions?: boolean;
  privacy?: {
    publicProfile?: boolean;
    showCompletedCourses?: boolean;
    showCountry?: boolean;
    personalizedAiRecommendations?: boolean;
  };
  emailPreferences?: Record<string, boolean>;
};

type ProfileUpdateBody = {
  name?: string;
  phone?: string;
  profilePicture?: unknown;
  photoURL?: unknown;
  avatarUrl?: unknown;
  addressStreet?: string;
  addressCity?: string;
  addressPostalCode?: string;
  countryName?: string;
  countryCode?: string;
  storeName?: string;
  storeDescription?: string;
  emailPreferences?: {
    security?: boolean;
  };
  academyProfile?: AcademyProfileUpdate;
};

type ProfilePictureUpdate = {
  shouldUpdate: boolean;
  value: string;
};

type SignInAlertDecision = {
  reason: string;
  shouldSend: boolean;
  throttleMs: number;
};

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    @Inject(FirebaseAdminService)
    private readonly firebaseAdmin: FirebaseAdminService,
    @Inject(SessionSignerService)
    private readonly sessionSigner: SessionSignerService,
    @Inject(MfaBackupCodeService)
    private readonly mfaBackupCodes: MfaBackupCodeService,
    @Inject(ResendService)
    private readonly resendService: ResendService,
    @Inject(AppsService)
    private readonly appsService: AppsService,
    @Inject(SecurityEventsService)
    private readonly securityEvents: SecurityEventsService,
    @Inject(RuntimeLimitService)
    private readonly runtimeLimits: RuntimeLimitService,
  ) {}

  @Get('me')
  @UseGuards(AuthGuard)
  async getCurrentUser(@Req() request: Request & { user?: AuthenticatedUser }) {
    if (!request.user) {
      throw new UnauthorizedException('Authenticated user missing from request.');
    }

    await this.recordServerDetectedCountry(request.user.email, request);
    const profile = await this.getUserProfile(request.user.email);

    return {
      user: {
        ...request.user,
        displayName: profile.name,
        photoURL: profile.profilePicture || null,
      },
      profile,
    };
  }

  @Get('security')
  @UseGuards(AuthGuard)
  async getSecuritySummary(
    @Req() request: Request & { user?: AuthenticatedUser },
  ) {
    return this.mfaBackupCodes.securitySummary({
      email: request.user?.email,
      uid: request.user?.uid,
    });
  }

  @Post('security-events/revoke')
  @UseGuards(AuthGuard, AdminGuard)
  async revokeSubjectSessions(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Body()
    body: {
      email?: string;
      reason?: string;
      uid?: string;
    },
  ) {
    const event = await this.securityEvents.publishSubjectRevocation({
      actor: request.user?.uid || request.user?.email || 'admin',
      email: body.email,
      reason: body.reason || 'admin_session_terminated',
      uid: body.uid,
    });

    this.logger.warn(
      JSON.stringify({
        event: 'security_subject_revoked',
        actorHash: hashForAudit(request.user?.uid || request.user?.email),
        reason: body.reason || 'admin_session_terminated',
        targetEmailHash: hashForAudit(body.email),
        targetUidHash: hashForAudit(body.uid),
        ...auditRequestContext(request),
      }),
    );

    return event;
  }

  @Patch('profile')
  @UseGuards(AuthGuard)
  async updateCurrentUserProfile(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Body() body: ProfileUpdateBody,
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = request.user;

    if (!user?.email) {
      throw new UnauthorizedException('Authenticated user missing from request.');
    }

    const updates: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
    };
    const authUpdates: {
      displayName?: string;
      photoURL?: string | null;
      phoneNumber?: string;
    } = {};

    if (body.name !== undefined) {
      const name = body.name.trim().replace(/\s+/g, ' ');

      if (name.length < 2) {
        throw new BadRequestException('Display name must be at least 2 characters.');
      }

      if (name.length > 80) {
        throw new BadRequestException('Display name must be 80 characters or less.');
      }

      updates.name = name;
      updates.fullname = name;
      authUpdates.displayName = name;
    }

    if (body.phone !== undefined) {
      const phone = body.phone.trim();

      if (phone && phone.length > 30) {
        throw new BadRequestException('Phone number must be 30 characters or less.');
      }

      updates.phone = phone || null;
      if (phone) {
        authUpdates.phoneNumber = phone;
      }
    }

    if (body.addressStreet !== undefined) {
      updates.addressStreet = body.addressStreet.trim();
    }

    if (body.addressCity !== undefined) {
      updates.addressCity = body.addressCity.trim();
    }

    if (body.addressPostalCode !== undefined) {
      updates.addressPostalCode = body.addressPostalCode.trim();
    }

    if (body.countryCode !== undefined || body.countryName !== undefined) {
      const code = (body.countryCode || '').trim().toUpperCase();
      const name = (body.countryName || '').trim();
      const country = {
        code: code || undefined,
        name: name || undefined,
      };

      if (country.code || country.name) {
        updates.country = {
          code: country.code || '',
          name: country.name || '',
        };
        if (country.code) {
          updates.countryCode = country.code;
        }
      }
    }

    if (body.storeName !== undefined) {
      updates.storeName = body.storeName.trim();
    }

    if (body.storeDescription !== undefined) {
      updates.storeDescription = body.storeDescription.trim();
    }

    const profilePictureUpdate = this.normalizeProfilePictureUpdate(body);
    if (profilePictureUpdate.shouldUpdate) {
      updates.profilePicture = profilePictureUpdate.value;
      updates.avatarUrl = profilePictureUpdate.value;
      updates.profilePictureSource = 'profile_api';
      updates.profilePictureUpdatedAt = FieldValue.serverTimestamp();
      authUpdates.photoURL = profilePictureUpdate.value || null;
    }

    if (body.emailPreferences?.security !== undefined) {
      updates.emailPreferences = {
        security: Boolean(body.emailPreferences.security),
      };
    }

    if (body.academyProfile) {
      Object.assign(
        updates,
        this.normalizeAcademyProfileUpdates(body.academyProfile),
        {
          apps: {
            academy: {
              enabled: true,
              lastSeenAt: FieldValue.serverTimestamp(),
            },
          },
        },
      );
    }

    Object.assign(updates, this.serverDetectedCountryUpdates(request));

    if (Object.keys(authUpdates).length > 0) {
      await this.firebaseAdmin.auth().updateUser(user.uid, authUpdates);
    }

    await this.firebaseAdmin
      .db()
      .collection('users')
      .doc(user.email)
      .set(updates, { merge: true });

    const profile = await this.getUserProfile(user.email);
    const meta = this.buildSessionMeta({
      email: user.email,
      name: profile.name || user.email.split('@')[0] || '',
      roles: profile.roles,
      uid: user.uid,
    });

    response.cookie(
      SESSION_META_COOKIE_NAME,
      this.sessionSigner.sign(meta),
      this.getCookieOptions(),
    );

    return {
      ok: true,
      user: {
        ...user,
        roles: profile.roles,
        displayName: profile.name,
        photoURL: profile.profilePicture || null,
      },
      profile,
    };
  }

  @Post('session')
  async createSession(
    @Headers('authorization') authorization: string | undefined,
    @Headers(CHEFU_APP_HEADER) chefuApp: string | undefined,
    @Headers(FLOW_SESSION_HEADER) flowSession: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
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
      throw new UnauthorizedException('Failed to verify Firebase session.');
    }

    if (
      sessionAppId === 'flow' &&
      !isFlowAllowedEmail(decodedToken.email)
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
      throw new UnauthorizedException('Failed to verify Firebase session.');
    }

    await this.ensureUserProfile(decodedToken, sessionAppId, request);
    const userProfile = await this.getUserProfile(decodedToken.email);
    const meta = this.buildSessionMeta({
      email: decodedToken.email || '',
      name:
        userProfile.name ||
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

    if (
      decodedToken.email &&
      tokenPayload?.firebase?.sign_in_provider &&
      userProfile.securityEmailsEnabled
    ) {
      void this.sendThrottledSignInNotification({
        email: decodedToken.email,
        uid: decodedToken.uid,
        userName: meta.name,
        provider: tokenPayload.firebase.sign_in_provider,
        request,
        appId: sessionAppId,
      });
    }

    return { ok: true, app: sessionAppId };
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

  @Post('send-otp')
  async sendOtp(@Body() body: { phone?: string }, @Req() request: Request) {
    if (!body.phone) {
      throw new BadRequestException('Phone required.');
    }

    const to = this.normalizePhone(body.phone);
    if (!to) {
      throw new BadRequestException(
        'Invalid phone format. Use country code plus number.',
      );
    }

    await this.enforceOtpThrottle(request.ip || 'unknown');
    this.logger.log(
      JSON.stringify({
        event: 'otp_send_started',
        ipHash: hashForAudit(request.ip),
        phoneLast4: to.slice(-4),
      }),
    );

    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_SYSTEM_USER_TOKEN;

    if (!phoneNumberId || !token) {
      throw new InternalServerErrorException('Missing WhatsApp env vars.');
    }

    const upstream = await fetch(
      `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: 'hello_world',
            language: {
              code: 'en_US',
            },
          },
        }),
      },
    );

    const data = (await upstream.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
    };

    if (!upstream.ok) {
      this.logger.error(
        JSON.stringify({
          event: 'otp_send_failed',
          statusCode: upstream.status,
          details: data,
        }),
      );
      throw new InternalServerErrorException({
        error: 'Failed to send OTP template',
        details: data,
      });
    }

    this.logger.log(
      JSON.stringify({
        event: 'otp_send_succeeded',
        messageId: data.messages?.[0]?.id || null,
      }),
    );

    return {
      success: true,
      messageId: data.messages?.[0]?.id,
    };
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
    const revocation = revokeGlobally
      ? await this.revokeCurrentSession(request)
      : { revoked: false, uidHash: null, emailHash: null };

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

    return { ok: true, revoked: revocation.revoked };
  }

  private buildSessionMeta({
    email,
    name,
    roles,
    uid,
  }: {
    email: string;
    name?: string;
    roles: string[];
    uid: string;
  }): SessionMeta {
    const now = Math.floor(Date.now() / 1000);

    return {
      aud: SESSION_META_AUDIENCE,
      uid,
      email,
      name,
      roles,
      iat: now,
      exp: now + SESSION_MAX_AGE_SECONDS,
      iss: SESSION_META_ISSUER,
    };
  }

  private assertRecentFirebaseSignIn(authTime?: number) {
    const maxAgeSeconds = Number(
      process.env.AUTH_SESSION_MAX_AUTH_AGE_SECONDS || 5 * 60,
    );
    const safeMaxAgeSeconds = Number.isFinite(maxAgeSeconds)
      ? Math.min(Math.max(maxAgeSeconds, 60), 24 * 60 * 60)
      : 5 * 60;
    const now = Math.floor(Date.now() / 1000);

    if (!authTime || now - authTime > safeMaxAgeSeconds) {
      throw new UnauthorizedException('Recent sign-in required.');
    }
  }

  private async revokeCurrentSession(request: Request) {
    const sessionCookie = request.cookies?.[SESSION_COOKIE_NAME];

    if (!sessionCookie) {
      return { revoked: false, uidHash: null, emailHash: null };
    }

    try {
      const decoded = await this.firebaseAdmin
        .auth()
        .verifySessionCookie(sessionCookie, false);

      await this.firebaseAdmin.auth().revokeRefreshTokens(decoded.uid);
      await this.recordSessionRevocation(decoded.email, decoded.uid);
      await this.securityEvents.publishSubjectRevocation({
        actor: decoded.uid,
        email: decoded.email,
        reason: 'global_logout',
        uid: decoded.uid,
      });

      return {
        revoked: true,
        uidHash: hashForAudit(decoded.uid),
        emailHash: hashForAudit(decoded.email),
      };
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'auth_session_revoke_failed',
          reason: error instanceof Error ? error.message : 'unknown',
          ...auditRequestContext(request),
        }),
      );

      return { revoked: false, uidHash: null, emailHash: null };
    }
  }

  private async recordSessionRevocation(email: string | undefined, uid: string) {
    const normalizedEmail = email?.trim().toLowerCase();
    if (!normalizedEmail) return;

    await this.firebaseAdmin
      .db()
      .collection('users')
      .doc(normalizedEmail)
      .set(
        {
          sessionRevokedAt: FieldValue.serverTimestamp(),
          sessionRevokedUid: uid,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  }

  private clearSessionCookies(response: Response) {
    for (const options of this.getClearCookieOptionsList()) {
      response.clearCookie(SESSION_COOKIE_NAME, options);
      response.clearCookie(SESSION_META_COOKIE_NAME, options);
      response.cookie(SESSION_COOKIE_NAME, '', {
        ...options,
        expires: new Date(0),
        maxAge: 0,
      });
      response.cookie(SESSION_META_COOKIE_NAME, '', {
        ...options,
        expires: new Date(0),
        maxAge: 0,
      });
    }
  }

  private getCookieOptions() {
    const cookieDomain =
      process.env.NODE_ENV === 'production'
        ? process.env.AUTH_COOKIE_DOMAIN || undefined
        : undefined;

    return {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      path: '/',
      domain: cookieDomain,
      maxAge: SESSION_MAX_AGE_SECONDS * 1000,
    };
  }

  private resolveSessionAppId(
    chefuApp: string | undefined,
    flowSession: string | undefined,
  ): ChefuAppId {
    const resolvedAppId = this.appsService.resolveId(chefuApp);
    const isFlowRequest = isFlowSessionRequest(flowSession);

    if (chefuApp && !resolvedAppId) {
      throw new BadRequestException(`Unknown app "${chefuApp}".`);
    }

    if (isFlowRequest && resolvedAppId && resolvedAppId !== 'flow') {
      throw new BadRequestException('Flow session header conflicts with app id.');
    }

    if (isFlowRequest) return 'flow';

    return resolvedAppId || 'academy';
  }

  private getClearCookieOptionsList() {
    const cookieDomain =
      process.env.NODE_ENV === 'production'
        ? process.env.AUTH_COOKIE_DOMAIN || undefined
        : undefined;

    return [
      {
        path: '/',
        domain: cookieDomain,
      },
      {
        path: '/',
      },
    ];
  }

  private async getUserProfile(email?: string) {
    if (!email) {
      return {
        name: '',
        profilePicture: '',
        bio: '',
        country: '',
        countryCode: '',
        detectedCountryCode: '',
        detectedCountrySource: '',
        detectedCountryUpdatedAt: null,
        language: 'en',
        learningGoal: '',
        skillLevel: null,
        learningInterests: [],
        weeklyLearningGoal: 3,
        lessonStyle: null,
        defaultCourseDifficulty: null,
        preferredContentFormat: null,
        aiTutorSuggestions: true,
        privacy: this.normalizePrivacy(null),
        onboardingComplete: false,
        appGuideComplete: false,
        subscriptionStatus: 'free',
        member: false,
        emailPreferences: this.normalizeEmailPreferences(null),
        roles: [],
        securityEmailsEnabled: true,
        apps: {},
      };
    }

    const snapshot = await this.firebaseAdmin
      .db()
      .collection('users')
      .doc(email)
      .get();

    const data = snapshot.data() || {};
    const name =
      typeof data?.fullname === 'string'
        ? data.fullname
        : typeof data?.name === 'string'
          ? data.name
          : '';
    const roles = data.roles;
    const emailPreferences = this.normalizeEmailPreferences(
      data.emailPreferences,
    );
    return {
      name,
      phone: this.stringValue(data.phone),
      profilePicture: this.stringValue(data.profilePicture),
      avatarUrl: this.stringValue(data.avatarUrl) || this.stringValue(data.profilePicture),
      bio: this.stringValue(data.bio),
      country:
        data.country && typeof data.country === 'object' && !Array.isArray(data.country)
          ? {
              code: this.stringValue((data.country as Record<string, unknown>).code),
              name: this.stringValue((data.country as Record<string, unknown>).name),
            }
          : { code: this.stringValue(data.countryCode), name: this.stringValue(data.countryName) },
      countryCode: this.stringValue(data.countryCode),
      countryName: this.stringValue(data.countryName),
      addressStreet: this.stringValue(data.addressStreet),
      addressCity: this.stringValue(data.addressCity),
      addressPostalCode: this.stringValue(data.addressPostalCode),
      storeName: this.stringValue(data.storeName),
      storeDescription: this.stringValue(data.storeDescription),
      detectedCountryCode: this.stringValue(data.detectedCountryCode),
      detectedCountrySource: this.stringValue(data.detectedCountrySource),
      detectedCountryUpdatedAt: this.timestampToIso(data.detectedCountryUpdatedAt),
      language: this.stringValue(data.language) || 'en',
      learningGoal: this.stringValue(data.learningGoal),
      skillLevel: this.enumValue(data.skillLevel, [
        'beginner',
        'intermediate',
        'advanced',
      ]),
      learningInterests: Array.isArray(data.learningInterests)
        ? data.learningInterests.map(String).slice(0, 12)
        : [],
      weeklyLearningGoal: this.numberValue(data.weeklyLearningGoal, 3),
      lessonStyle: this.enumValue(data.lessonStyle, [
        'short',
        'detailed',
        'example-heavy',
      ]),
      defaultCourseDifficulty: this.enumValue(data.defaultCourseDifficulty, [
        'beginner',
        'intermediate',
        'advanced',
      ]),
      preferredContentFormat: this.enumValue(data.preferredContentFormat, [
        'text',
        'examples',
        'quizzes',
      ]),
      aiTutorSuggestions: data.aiTutorSuggestions !== false,
      privacy: this.normalizePrivacy(data.privacy),
      onboardingComplete: data.onboardingComplete === true,
      appGuideComplete: data.appGuideComplete === true,
      subscriptionStatus: this.stringValue(data.subscriptionStatus) || 'free',
      member: data.member === true,
      emailPreferences,
      roles: Array.isArray(roles) ? roles.map(String) : [],
      securityEmailsEnabled: emailPreferences.security !== false,
      apps: this.normalizeAppProfileSummary(data?.apps),
    };
  }

  private normalizeAcademyProfileUpdates(profile: AcademyProfileUpdate) {
    const updates: Record<string, unknown> = {};

    if (profile.bio !== undefined) {
      updates.bio = profile.bio.trim().slice(0, 280);
    }

    if (profile.language !== undefined) {
      updates.language = profile.language.trim().toLowerCase().slice(0, 12) || 'en';
    }

    if (profile.learningGoal !== undefined) {
      updates.learningGoal = profile.learningGoal.trim().slice(0, 160);
    }

    const skillLevel = this.enumValue(profile.skillLevel, [
      'beginner',
      'intermediate',
      'advanced',
    ]);
    if (skillLevel) updates.skillLevel = skillLevel;

    if (Array.isArray(profile.learningInterests)) {
      updates.learningInterests = profile.learningInterests
        .map(interest => String(interest).trim())
        .filter(Boolean)
        .slice(0, 12);
    }

    if (profile.weeklyLearningGoal !== undefined) {
      const weeklyGoal = Number(profile.weeklyLearningGoal);
      updates.weeklyLearningGoal = Number.isFinite(weeklyGoal)
        ? Math.min(Math.max(Math.round(weeklyGoal), 1), 21)
        : 3;
    }

    const lessonStyle = this.enumValue(profile.lessonStyle, [
      'short',
      'detailed',
      'example-heavy',
    ]);
    if (lessonStyle) updates.lessonStyle = lessonStyle;

    const defaultCourseDifficulty = this.enumValue(
      profile.defaultCourseDifficulty,
      ['beginner', 'intermediate', 'advanced'],
    );
    if (defaultCourseDifficulty) {
      updates.defaultCourseDifficulty = defaultCourseDifficulty;
    }

    const preferredContentFormat = this.enumValue(
      profile.preferredContentFormat,
      ['text', 'examples', 'quizzes'],
    );
    if (preferredContentFormat) {
      updates.preferredContentFormat = preferredContentFormat;
    }

    if (profile.aiTutorSuggestions !== undefined) {
      updates.aiTutorSuggestions = Boolean(profile.aiTutorSuggestions);
    }

    if (profile.privacy) {
      updates.privacy = this.normalizePrivacy(profile.privacy);
    }

    if (profile.emailPreferences) {
      updates.emailPreferences = this.normalizeEmailPreferences(
        profile.emailPreferences,
      );
    }

    return updates;
  }

  private normalizeEmailPreferences(value: unknown) {
    const prefs =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    return {
      activity: prefs.activity === true,
      general: prefs.general === true,
      marketing: prefs.marketing === true,
      security: prefs.security !== false,
      courseReminders: prefs.courseReminders !== false,
      aiCourseCompletion: prefs.aiCourseCompletion === true,
      weeklyProgressSummary: prefs.weeklyProgressSummary === true,
    };
  }

  private normalizePrivacy(value: unknown) {
    const privacy =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    return {
      publicProfile: privacy.publicProfile === true,
      showCompletedCourses: privacy.showCompletedCourses === true,
      showCountry: privacy.showCountry !== false,
      personalizedAiRecommendations:
        privacy.personalizedAiRecommendations !== false,
    };
  }

  private normalizeProfilePictureUpdate(
    body: ProfileUpdateBody,
  ): ProfilePictureUpdate {
    const fields = ['profilePicture', 'photoURL', 'avatarUrl'] as const;
    const providedValues = fields
      .filter(field => Object.prototype.hasOwnProperty.call(body, field))
      .map(field => this.normalizeProfilePictureUrl(body[field]));

    if (providedValues.length === 0) {
      return {
        shouldUpdate: false,
        value: '',
      };
    }

    if (new Set(providedValues).size > 1) {
      throw new BadRequestException(
        'Profile picture fields must resolve to the same URL.',
      );
    }

    return {
      shouldUpdate: true,
      value: providedValues[0] || '',
    };
  }

  private normalizeFirebaseProfilePicture(decodedToken: FirebaseDecodedToken) {
    const token = decodedToken as FirebaseDecodedToken & {
      photoURL?: unknown;
      picture?: unknown;
    };

    try {
      return this.normalizeProfilePictureUrl(token.picture ?? token.photoURL);
    } catch {
      return '';
    }
  }

  private normalizeProfilePictureUrl(value: unknown) {
    if (value === null || value === undefined) return '';
    if (typeof value !== 'string') {
      throw new BadRequestException('Profile picture must be a URL string.');
    }

    const trimmed = value.trim();
    if (!trimmed) return '';

    if (trimmed.length > 2048) {
      throw new BadRequestException(
        'Profile picture URL must be 2048 characters or less.',
      );
    }

    if (this.hasUnsafeUrlCharacters(trimmed)) {
      throw new BadRequestException(
        'Profile picture URL contains unsafe characters.',
      );
    }

    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new BadRequestException('Profile picture must be a valid URL.');
    }

    if (url.username || url.password || url.hash) {
      throw new BadRequestException(
        'Profile picture URL must not include credentials or fragments.',
      );
    }

    if (url.protocol !== 'https:' && !this.isLocalDevelopmentUrl(url)) {
      throw new BadRequestException('Profile picture URL must use HTTPS.');
    }

    return url.toString();
  }

  private hasUnsafeUrlCharacters(value: string) {
    return (
      /%(?:00|0a|0d|5c)/i.test(value) ||
      Array.from(value).some(
        character => character === '\\' || character.charCodeAt(0) < 0x20,
      )
    );
  }

  private isLocalDevelopmentUrl(url: URL) {
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    );
  }

  private stringValue(value: unknown) {
    return typeof value === 'string' ? value : '';
  }

  private numberValue(value: unknown, fallback: number) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  private enumValue<T extends string>(value: unknown, allowed: T[]) {
    return allowed.includes(value as T) ? (value as T) : null;
  }

  private normalizeAppProfileSummary(apps: unknown) {
    if (!apps || typeof apps !== 'object' || Array.isArray(apps)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(apps as Record<string, Record<string, unknown>>).map(
        ([appId, app]) => [
          appId,
          {
            enabled: app?.enabled !== false,
            firstSeenAt: this.timestampToIso(app?.firstSeenAt),
            lastSeenAt: this.timestampToIso(app?.lastSeenAt),
          },
        ],
      ),
    );
  }

  private timestampToIso(value: unknown) {
    if (
      value &&
      typeof value === 'object' &&
      'toDate' in value &&
      typeof (value as { toDate?: unknown }).toDate === 'function'
    ) {
      return (value as { toDate: () => Date }).toDate().toISOString();
    }

    return null;
  }

  private async recordServerDetectedCountry(
    email: string | undefined,
    request: Request,
  ) {
    const normalizedEmail = email?.trim().toLowerCase();
    const updates = this.serverDetectedCountryUpdates(request);

    if (!normalizedEmail || Object.keys(updates).length === 0) return;

    await this.firebaseAdmin
      .db()
      .collection('users')
      .doc(normalizedEmail)
      .set(updates, { merge: true })
      .catch(error => {
        this.logger.warn(
          JSON.stringify({
            event: 'auth_detected_country_update_failed',
            emailHash: hashForAudit(normalizedEmail),
            reason: error instanceof Error ? error.message : 'unknown',
          }),
        );
      });
  }

  private serverDetectedCountryUpdates(request?: Request) {
    const detectedCountry = this.getDetectedCountry(request);

    if (!detectedCountry) return {};

    return {
      detectedCountryCode: detectedCountry.code,
      detectedCountrySource: detectedCountry.source,
      detectedCountryUpdatedAt: FieldValue.serverTimestamp(),
    };
  }

  private getDetectedCountry(request?: Request) {
    if (!request) return null;

    const candidates: Array<[string, string]> = [
      ['cf-ipcountry', 'cloudflare'],
      ['x-vercel-ip-country', 'vercel'],
      ['cloudfront-viewer-country', 'cloudfront'],
      ['x-appengine-country', 'appengine'],
      ['x-country-code', 'proxy'],
    ];

    for (const [header, source] of candidates) {
      const code = this.normalizeCountryCode(request.header(header));
      if (code) return { code, source };
    }

    return null;
  }

  private normalizeCountryCode(value?: string) {
    const code = value?.trim().toUpperCase();

    if (!code || code === 'XX' || code === 'T1') return null;
    if (!/^[A-Z]{2}$/.test(code)) return null;

    return code;
  }

  private async ensureUserProfile(
    decodedToken: FirebaseDecodedToken,
    appId: ChefuAppId,
    request?: Request,
  ) {
    const email = decodedToken.email?.trim().toLowerCase();
    if (!email) return;

    const db = this.firebaseAdmin.db();
    const userRef = db.collection('users').doc(email);
    const appProfileRef = userRef.collection('appProfiles').doc(appId);
    const [userSnapshot, appProfileSnapshot] = await Promise.all([
      userRef.get(),
      appProfileRef.get(),
    ]);
    const existingUser = userSnapshot.data();
    const existingRoles = existingUser?.roles;
    const name =
      typeof existingUser?.fullname === 'string'
        ? existingUser.fullname
        : typeof existingUser?.name === 'string'
          ? existingUser.name
          : decodedToken.name || email.split('@')[0] || '';
    const now = FieldValue.serverTimestamp();
    const detectedCountry = this.getDetectedCountry(request);
    const firebaseProfilePicture =
      this.normalizeFirebaseProfilePicture(decodedToken);
    const shouldSeedProfilePicture =
      firebaseProfilePicture && !this.stringValue(existingUser?.profilePicture);

    await userRef.set(
      {
        ...(!userSnapshot.exists ? { createdAt: now } : {}),
        uid: decodedToken.uid,
        email,
        fullname: name,
        name,
        roles:
          Array.isArray(existingRoles) && existingRoles.length > 0
            ? existingRoles.map(String)
            : ['user'],
        authProvider: decodedToken.firebase?.sign_in_provider || 'unknown',
        ...(shouldSeedProfilePicture
          ? {
              profilePicture: firebaseProfilePicture,
              profilePictureSource: 'firebase_auth',
              profilePictureUpdatedAt: now,
            }
          : {}),
        ...(detectedCountry
          ? {
              detectedCountryCode: detectedCountry.code,
              detectedCountrySource: detectedCountry.source,
              detectedCountryUpdatedAt: now,
              ...(!existingUser?.countryCode
                ? { countryCode: detectedCountry.code }
                : {}),
            }
          : {}),
        lastLoginAt: now,
        updatedAt: now,
        apps: {
          [appId]: {
            enabled: true,
            ...(!appProfileSnapshot.exists ? { firstSeenAt: now } : {}),
            lastSeenAt: now,
          },
        },
      },
      { merge: true },
    );

    await appProfileRef.set(
      {
        ...(!appProfileSnapshot.exists ? { createdAt: now } : {}),
        appId,
        enabled: true,
        lastLoginAt: now,
        updatedAt: now,
      },
      { merge: true },
    );
  }

  private async sendThrottledSignInNotification({
    email,
    provider,
    request,
    uid,
    userName,
    appId,
  }: {
    email: string;
    provider: string;
    request: Request;
    uid: string;
    userName?: string;
    appId?: ChefuAppId;
  }) {
    try {
      const decision = await this.reserveSignInAlert({
        email,
        provider,
        request,
      });

      if (!decision.shouldSend) {
        this.logger.log(
          JSON.stringify({
            event: 'auth_sign_in_notification_suppressed',
            uidHash: hashForAudit(uid),
            emailHash: hashForAudit(email),
            reason: decision.reason,
            throttleMs: decision.throttleMs,
          }),
        );
        return;
      }

      await this.resendService.sendSignInNotification({
        email,
        userName,
        provider,
        deviceInfo: request.headers['user-agent'] || undefined,
        ipAddress: this.getClientIp(request),
        timestamp: new Date(),
        appId,
      });

      this.logger.log(
        JSON.stringify({
          event: 'auth_sign_in_notification_sent',
          uidHash: hashForAudit(uid),
          emailHash: hashForAudit(email),
          reason: decision.reason,
        }),
      );
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'auth_sign_in_notification_failed',
          uidHash: hashForAudit(uid),
          emailHash: hashForAudit(email),
          reason: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }
  }

  private async reserveSignInAlert({
    email,
    provider,
    request,
  }: {
    email: string;
    provider: string;
    request: Request;
  }): Promise<SignInAlertDecision> {
    const normalizedEmail = email.trim().toLowerCase();
    const userRef = this.firebaseAdmin.db().collection('users').doc(normalizedEmail);
    const fingerprint = this.signInAlertFingerprint(provider, request);
    const userAgentHash = this.hashValue(request.headers['user-agent'] || 'unknown');
    const ipHash = this.hashValue(this.ipFingerprintSource(request));
    const detectedCountry = this.getDetectedCountry(request);
    const throttleMs = this.signInAlertThrottleMs();
    const nowMs = Date.now();

    return this.firebaseAdmin.db().runTransaction(async tx => {
      const snapshot = await tx.get(userRef);
      const data = snapshot.data() || {};
      const existingAlert =
        data.signInAlert &&
        typeof data.signInAlert === 'object' &&
        !Array.isArray(data.signInAlert)
          ? (data.signInAlert as Record<string, unknown>)
          : {};

      const lastFingerprint = this.stringValue(existingAlert.fingerprint);
      const lastCountryCode = this.stringValue(existingAlert.countryCode);
      const lastSentAtMs =
        this.numberValue(existingAlert.lastSentAtMs, 0) ||
        this.timestampToMillis(existingAlert.lastSentAt);
      const isFirstAlert = !lastSentAtMs;
      const isNewFingerprint =
        Boolean(lastFingerprint) && lastFingerprint !== fingerprint;
      const countryChanged =
        Boolean(detectedCountry?.code) &&
        Boolean(lastCountryCode) &&
        lastCountryCode !== detectedCountry?.code;
      const throttleExpired =
        !lastSentAtMs || nowMs - lastSentAtMs >= throttleMs;
      const shouldSend =
        isFirstAlert || isNewFingerprint || countryChanged || throttleExpired;
      const reason = isFirstAlert
        ? 'first_alert'
        : isNewFingerprint
          ? 'new_device_or_network'
          : countryChanged
            ? 'country_changed'
            : throttleExpired
              ? 'throttle_expired'
              : 'recent_same_session';

      tx.set(
        userRef,
        {
          signInAlert: {
            ...existingAlert,
            fingerprint,
            provider,
            countryCode: detectedCountry?.code || null,
            countrySource: detectedCountry?.source || null,
            userAgentHash,
            ipHash,
            lastSeenAt: FieldValue.serverTimestamp(),
            lastSeenAtMs: nowMs,
            ...(shouldSend
              ? {
                  lastSentAt: FieldValue.serverTimestamp(),
                  lastSentAtMs: nowMs,
                  lastSentReason: reason,
                }
              : {
                  lastSuppressedAt: FieldValue.serverTimestamp(),
                  lastSuppressedAtMs: nowMs,
                  lastSuppressedReason: reason,
                }),
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return {
        reason,
        shouldSend,
        throttleMs,
      };
    });
  }

  private signInAlertFingerprint(provider: string, request: Request) {
    return this.hashValue(
      [
        provider,
        this.ipFingerprintSource(request),
        request.headers['user-agent'] || 'unknown',
      ].join('|'),
    );
  }

  private ipFingerprintSource(request: Request) {
    const ip = this.getClientIp(request) || 'unknown';

    if (ip.includes(':')) {
      return ip.split(':').filter(Boolean).slice(0, 4).join(':') || ip;
    }

    const parts = ip.split('.');
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
    }

    return ip;
  }

  private hashValue(value: string) {
    const secret =
      process.env.SIGNIN_ALERT_FINGERPRINT_SECRET ||
      this.firebaseAdmin.projectId() ||
      'chefu-signin-alert';

    return createHash('sha256').update(`${secret}:${value}`).digest('hex');
  }

  private signInAlertThrottleMs() {
    const configuredMinutes = Number(
      process.env.SIGNIN_ALERT_THROTTLE_MINUTES || 360,
    );
    const safeMinutes = Number.isFinite(configuredMinutes)
      ? Math.min(Math.max(configuredMinutes, 5), 24 * 60)
      : 360;

    return safeMinutes * 60 * 1000;
  }

  private timestampToMillis(value: unknown) {
    if (
      value &&
      typeof value === 'object' &&
      'toMillis' in value &&
      typeof (value as { toMillis?: unknown }).toMillis === 'function'
    ) {
      return (value as { toMillis: () => number }).toMillis();
    }

    if (
      value &&
      typeof value === 'object' &&
      'toDate' in value &&
      typeof (value as { toDate?: unknown }).toDate === 'function'
    ) {
      return (value as { toDate: () => Date }).toDate().getTime();
    }

    return 0;
  }

  private getClientIp(request: Request) {
    const forwardedFor = request.headers['x-forwarded-for'];
    const firstForwardedIp = Array.isArray(forwardedFor)
      ? forwardedFor[0]
      : forwardedFor?.split(',')[0];

    return firstForwardedIp?.trim() || request.ip || undefined;
  }

  private normalizePhone(input: string) {
    const digits = input.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return null;
    return digits;
  }

  private async enforceOtpThrottle(ip: string) {
    const result = await this.runtimeLimits.reserve({
      collection: 'runtime_otp_send_limits',
      key: ip,
      limit: 5,
      windowMs: 10 * 60 * 1000,
    });

    if (result.limited) {
      throw new BadRequestException('Too many OTP requests. Try again later.');
    }
  }
}
