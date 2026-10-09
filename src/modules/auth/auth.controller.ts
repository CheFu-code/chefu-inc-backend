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
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import isEmail from 'validator/lib/isEmail';
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
  fullname?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  bio?: string;
  website?: string;
  location?: string;
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
    @Inject(ProfilePictureService)
    private readonly profilePictureService: ProfilePictureService,
  ) {}

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

    await this.enforceAuthRateLimit(email, request.ip || 'unknown');

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
        error?: { message?: string };
      };
      throw new UnauthorizedException(
        errorBody.error?.message || 'Invalid email or password.',
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
      if (requiresMfa || upstreamErrorCode === 'MFA_REQUIRED') {
        throw new UnauthorizedException(
          'This account requires multi-factor verification, which Nook sign-in does not support yet. Sign in through Chefu Account or use an account without MFA enabled.',
        );
      }
      throw new BadGatewayException(
        'The authentication service returned an unexpected response. Please try again later.',
      );
    }

    return {
      token: idToken,
      idToken,
      refreshToken: payload.refreshToken || payload.refresh_token || '',
      expiresIn: payload.expiresIn || payload.expires_in || '',
      user: {
        uid: payload.localId || payload.local_id || '',
        email: payload.email || email,
      },
    };
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

  @Get('activity')
  @UseGuards(AuthGuard)
  async getAccountActivity(
    @Req() request: Request & { user?: AuthenticatedUser },
  ) {
    const user = request.user;
    if (!user?.email || !user.uid) {
      throw new UnauthorizedException('Authenticated user missing from request.');
    }
    return this.securityEvents.listAccountActivity(user.email, user.uid);
  }

  @Post('security-activity')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async recordSecurityActivity(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Body() body: { eventType?: unknown },
  ) {
    const user = request.user;
    if (!user?.email || !user.uid) {
      throw new UnauthorizedException('Authenticated user missing from request.');
    }

    if (
      body.eventType !== 'password_changed' &&
      body.eventType !== 'password_reset_email_sent' &&
      body.eventType !== 'mfa_enabled' &&
      body.eventType !== 'mfa_disabled'
    ) {
      throw new BadRequestException('Unsupported security activity.');
    }

    const eventType = body.eventType as AccountSecurityActivityType;
    if (eventType === 'mfa_enabled' || eventType === 'mfa_disabled') {
      const authUser = await this.firebaseAdmin.auth().getUser(user.uid);
      const mfaEnabled = (authUser.multiFactor?.enrolledFactors.length || 0) > 0;
      if (
        (eventType === 'mfa_enabled' && !mfaEnabled) ||
        (eventType === 'mfa_disabled' && mfaEnabled)
      ) {
        throw new BadRequestException('The reported MFA change is not active.');
      }
    }

    return this.securityEvents.recordAccountActivity({
      uid: user.uid,
      email: user.email,
      eventType,
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

    if (body.fullname !== undefined) {
      const name = body.fullname.trim().replace(/\s+/g, ' ');

      if (name.length < 2) {
        throw new BadRequestException('Display name must be at least 2 characters.');
      }

      if (name.length > 80) {
        throw new BadRequestException('Display name must be 80 characters or less.');
      }

      updates.fullname = name;
      updates.name = FieldValue.delete();
      const nameParts = name.split(' ');
      updates.firstName = nameParts[0];
      updates.lastName = nameParts.slice(1).join(' ');
      authUpdates.displayName = name;
    }

    if (body.firstName !== undefined || body.lastName !== undefined) {
      const firstName = (body.firstName || '').trim().replace(/\s+/g, ' ');
      const lastName = (body.lastName || '').trim().replace(/\s+/g, ' ');
      if (!firstName || !lastName) {
        throw new BadRequestException('First name and last name are required.');
      }
      const fullname = `${firstName} ${lastName}`;
      updates.firstName = firstName;
      updates.lastName = lastName;
      updates.fullname = fullname;
      updates.name = FieldValue.delete();
      authUpdates.displayName = fullname;
    }

    if (body.phone !== undefined) {
      const phone = body.phone.trim();

      if (phone && phone.length > 30) {
        throw new BadRequestException('Phone number must be 30 characters or less.');
      }

      updates.phone = phone || null;

      const firebasePhoneNumber = phone
        ? this.normalizeFirebasePhoneNumber(phone)
        : null;

      if (firebasePhoneNumber) {
        authUpdates.phoneNumber = firebasePhoneNumber;
      }
    }

    if (body.bio !== undefined) {
      const bio = body.bio.trim();
      if (bio.length > 280) {
        throw new BadRequestException('Bio must be 280 characters or less.');
      }
      updates.bio = bio;
    }

    if (body.website !== undefined) {
      const website = body.website.trim();
      if (website.length > 200) {
        throw new BadRequestException('Website must be 200 characters or less.');
      }
      if (website) {
        let parsed: URL;
        try {
          parsed = new URL(website);
        } catch {
          throw new BadRequestException('Website must be a valid HTTP or HTTPS URL.');
        }
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname.includes('.')) {
          throw new BadRequestException('Website must be a valid HTTP or HTTPS URL.');
        }
      }
      updates.website = website;
    }

    if (body.location !== undefined) {
      const location = body.location.trim();
      if (location.length > 200) {
        throw new BadRequestException('Location must be 200 characters or less.');
      }
      updates.location = location;
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
      name: profile.fullname || profile.firstName || user.email.split('@')[0] || '',
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
        displayName: profile.fullname,
        photoURL: profile.profilePicture || null,
      },
      profile,
    };
  }

  @Post('device/start')
  async startDeviceAuth(@Req() request: Request) {
    const challenge = buildDeviceAuthChallenge();

    const deviceKey = `device_auth:${normalizeDeviceCode(challenge.deviceCode)}`;
    const sessionPayload = {
      deviceCode: challenge.deviceCode,
      userCode: challenge.userCode,
      status: 'pending',
      createdAt: challenge.createdAt,
      expiresAt: challenge.expiresAt,
      verificationUri: challenge.verificationUri,
      intervalSeconds: challenge.intervalSeconds,
    };

    await this.firebaseAdmin.db().collection('device_auth_sessions').doc(deviceKey).set(sessionPayload);

    this.logger.log(
      JSON.stringify({
        event: 'device_auth_started',
        deviceCodeHash: createHash('sha256').update(challenge.deviceCode).digest('hex').slice(0, 16),
        userCode: challenge.userCode,
        ...auditRequestContext(request),
      }),
    );

    return {
      ok: true,
      deviceCode: challenge.deviceCode,
      userCode: challenge.userCode,
      verificationUri: challenge.verificationUri,
      expiresAt: challenge.expiresAt,
      intervalSeconds: challenge.intervalSeconds,
    };
  }

  @Post('device/complete')
  async completeDeviceAuth(
    @Body() body: { deviceCode?: string; userCode?: string; email?: string; password?: string },
    @Req() request: Request,
  ) {
    const deviceCode = normalizeDeviceCode(body.deviceCode);
    const userCode = normalizeDeviceCode(body.userCode);

    if (!deviceCode || !userCode) {
      throw new BadRequestException('deviceCode and userCode are required.');
    }

    const ref = this.firebaseAdmin.db().collection('device_auth_sessions').doc(`device_auth:${deviceCode}`);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      throw new BadRequestException('Unknown or expired device code.');
    }

    const record = snapshot.data() as {
      userCode?: string;
      status?: string;
      createdAt?: number;
      expiresAt?: number;
      uid?: string;
      email?: string;
      idToken?: string;
    };

    if (record.status !== 'pending') {
      throw new BadRequestException(`This device code is already ${record.status}.`);
    }

    if (isDeviceAuthExpired({ createdAt: Number(record.createdAt || Date.now()), expiresAt: Number(record.expiresAt || Date.now()) })) {
      await ref.set({ status: 'expired' }, { merge: true });
      throw new BadRequestException('This device code has expired. Please try again.');
    }

    if (record.userCode && normalizeDeviceCode(record.userCode) !== userCode) {
      throw new BadRequestException('User code does not match this device code.');
    }

    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '').trim();
    if (!email || !password) {
      throw new BadRequestException('Email and password are required to finish device sign-in.');
    }

    await this.enforceAuthRateLimit(email, request.ip || 'unknown');

    const apiKey = process.env.FIREBASE_WEB_API_KEY || process.env.FIREBASE_API_KEY;
    if (!apiKey) {
      throw new InternalServerErrorException('Firebase web API key is not configured.');
    }

    const signInRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      },
    );

    if (!signInRes.ok) {
      const errorBody = (await signInRes.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new UnauthorizedException(errorBody.error?.message || 'Invalid email or password.');
    }

    const payload = (await signInRes.json()) as { idToken?: string; localId?: string; email?: string };
    if (!payload.idToken) {
      throw new InternalServerErrorException('Unable to complete device sign-in.');
    }

    await ref.set({
      status: 'approved',
      uid: payload.localId || '',
      email: payload.email || email,
      idToken: payload.idToken,
      approvedAt: Date.now(),
    }, { merge: true });

    return {
      ok: true,
      status: 'approved',
      email: payload.email || email,
      token: payload.idToken,
    };
  }

  @Post('device/status')
  async getDeviceAuthStatus(@Body() body: { deviceCode?: string }, @Req() request: Request) {
    const deviceCode = normalizeDeviceCode(body.deviceCode);
    if (!deviceCode) {
      throw new BadRequestException('deviceCode is required.');
    }

    const ref = this.firebaseAdmin.db().collection('device_auth_sessions').doc(`device_auth:${deviceCode}`);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      return { ok: true, status: 'expired' };
    }

    const record = snapshot.data() as {
      status?: string;
      expiresAt?: number;
      token?: string;
      idToken?: string;
      email?: string;
      uid?: string;
    };

    if (isDeviceAuthExpired({ createdAt: Date.now(), expiresAt: Number(record.expiresAt || Date.now()) })) {
      await ref.set({ status: 'expired' }, { merge: true });
      return { ok: true, status: 'expired' };
    }

    return {
      ok: true,
      status: record.status || 'pending',
      email: record.email || null,
      uid: record.uid || null,
      token: record.token || record.idToken || null,
    };
  }

  @Post('email-verification/send')
  @HttpCode(200)
  async sendEmailVerificationCode(
    @Body() body: { email?: string; userName?: string },
    @Req() request: Request,
  ) {
    const email = String(body.email || '').trim().toLowerCase();
    if (email.length > 254 || !isEmail(email)) {
      throw new BadRequestException('Enter a valid email address.');
    }
    await this.enforceAuthRateLimit(email, request.ip || 'unknown');

    try {
      const existingUser = await this.firebaseAdmin.auth().getUserByEmail(email);
      if (existingUser.emailVerified) {
        throw new ConflictException('This email is already registered. Try logging in.');
      }
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'auth/user-not-found'
      ) {
        throw error;
      }
    }

    const code = String(randomInt(100000, 1000000));
    const codeHash = createHash('sha256').update(code).digest('hex');
    const ref = this.firebaseAdmin.db()
      .collection('email_verification_challenges')
      .doc(createHash('sha256').update(email).digest('hex'));
    const now = Date.now();

    await this.firebaseAdmin.db().runTransaction(async transaction => {
      const existing = await transaction.get(ref);
      const data = existing.data() as {
        lastSentAt?: Timestamp | Date;
        status?: string;
        creationClaimExpiresAt?: Timestamp | Date;
      } | undefined;
      const lastSentAt = data?.lastSentAt instanceof Date
        ? data.lastSentAt.getTime()
        : data?.lastSentAt?.toMillis() ?? 0;
      const claimExpiresAt = data?.creationClaimExpiresAt instanceof Date
        ? data.creationClaimExpiresAt.getTime()
        : data?.creationClaimExpiresAt?.toMillis() ?? 0;
      if (data?.status === 'creating' && claimExpiresAt > now) {
        throw new ConflictException('Registration is already being completed.');
      }
      if (now - lastSentAt < 60_000) {
        throw new BadRequestException('Please wait before requesting another verification code.');
      }

      transaction.set(ref, {
        email,
        userName: String(body.userName || '').trim().slice(0, 120) || null,
        appName: 'CheFu Account',
        codeHash,
        expiresAt: Timestamp.fromMillis(now + 10 * 60_000),
        lastSentAt: Timestamp.fromMillis(now),
        attempts: 0,
        status: 'pending',
      });
    });

    try {
      await this.resendService.sendEmailVerification({
        email,
        userName: String(body.userName || '').trim().slice(0, 120) || undefined,
        code,
        expiresIn: '10 minutes',
        appName: 'CheFu Account',
      });
    } catch (error) {
      await this.firebaseAdmin.db().runTransaction(async transaction => {
        const current = await transaction.get(ref);
        if (current.get('codeHash') === codeHash) transaction.delete(ref);
      });
      throw error;
    }

    return { success: true, message: 'Verification code sent to your email.' };
  }

  @Post('email-verification/verify')
  @HttpCode(200)
  async verifyEmailVerificationCode(
    @Body() body: {
      email?: string;
      code?: string;
      password?: string;
      displayName?: string;
    },
    @Req() request: Request,
  ) {
    const email = String(body.email || '').trim().toLowerCase();
    const code = body.code?.trim() || '';
    const password = typeof body.password === 'string' ? body.password : '';
    const displayName = String(body.displayName || '').trim();
    if (email.length > 254 || !isEmail(email)) {
      throw new BadRequestException('Enter a valid email address.');
    }
    if (!/^\d{6}$/.test(code)) {
      throw new BadRequestException('Enter the 6-digit verification code.');
    }
    if (password.length < 6 || password.length > 128) {
      throw new BadRequestException('Password must be between 6 and 128 characters.');
    }
    if (!displayName || displayName.length > 120) {
      throw new BadRequestException('Enter a name up to 120 characters.');
    }
    await this.enforceAuthRateLimit(email, request.ip || 'unknown');

    const ref = this.firebaseAdmin.db()
      .collection('email_verification_challenges')
      .doc(createHash('sha256').update(email).digest('hex'));
    const claim = randomBytes(32).toString('hex');
    const claimHash = createHash('sha256').update(claim).digest('hex');
    const now = Date.now();
    const claimResult = await this.firebaseAdmin.db().runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return 'missing' as const;

      const data = snapshot.data() as {
        codeHash?: string;
        expiresAt?: Timestamp | Date;
        attempts?: number;
        status?: string;
        creationClaimExpiresAt?: Timestamp | Date;
      };
      const expiresAt = data.expiresAt instanceof Date
        ? data.expiresAt.getTime()
        : data.expiresAt?.toMillis() ?? 0;
      const claimExpiresAt = data.creationClaimExpiresAt instanceof Date
        ? data.creationClaimExpiresAt.getTime()
        : data.creationClaimExpiresAt?.toMillis() ?? 0;
      if (data.status === 'creating' && claimExpiresAt > now) {
        return 'in-progress' as const;
      }
      if (expiresAt <= now) {
        transaction.delete(ref);
        return 'expired' as const;
      }
      if (Number(data.attempts || 0) >= 5) {
        transaction.delete(ref);
        return 'locked' as const;
      }
      const submittedHash = createHash('sha256').update(code).digest();
      const expectedHash = Buffer.from(data.codeHash || '', 'hex');
      if (
        expectedHash.length !== submittedHash.length ||
        !timingSafeEqual(expectedHash, submittedHash)
      ) {
        const attempts = Number(data.attempts || 0) + 1;
        if (attempts >= 5) transaction.delete(ref);
        else transaction.update(ref, { attempts });
        return 'invalid' as const;
      }

      transaction.update(ref, {
        status: 'creating',
        creationClaimHash: claimHash,
        creationClaimExpiresAt: Timestamp.fromMillis(now + 2 * 60_000),
      });
      return 'claimed' as const;
    });

    if (claimResult === 'missing') {
      throw new BadRequestException('No active verification code found.');
    }
    if (claimResult === 'expired') {
      throw new BadRequestException('Verification code has expired.');
    }
    if (claimResult === 'locked') {
      throw new BadRequestException('Too many incorrect codes. Request a new code.');
    }
    if (claimResult === 'invalid') {
      throw new BadRequestException('Invalid verification code.');
    }
    if (claimResult === 'in-progress') {
      throw new ConflictException('Registration is already being completed.');
    }

    let createdUid: string;
    try {
      const firebaseAuth = this.firebaseAdmin.auth();
      let createdUser;
      try {
        const existingUser = await firebaseAuth.getUserByEmail(email);
        if (existingUser.emailVerified) {
          throw new ConflictException('This email is already registered. Try logging in.');
        }
        createdUser = await firebaseAuth.updateUser(existingUser.uid, {
          password,
          displayName,
          emailVerified: true,
          disabled: false,
        });
      } catch (error) {
        const errorCode =
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : '';
        if (errorCode !== 'auth/user-not-found') throw error;
        createdUser = await firebaseAuth.createUser({
          email,
          password,
          displayName,
          emailVerified: true,
          disabled: false,
        });
      }
      createdUid = createdUser.uid;
    } catch (error) {
      const codeValue =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : '';
      try {
        await this.firebaseAdmin.db().runTransaction(async transaction => {
          const current = await transaction.get(ref);
          if (current.get('creationClaimHash') !== claimHash) return;
          if (codeValue === 'auth/email-already-exists') {
            transaction.delete(ref);
            return;
          }
          transaction.update(ref, {
            status: 'pending',
            creationClaimHash: FieldValue.delete(),
            creationClaimExpiresAt: FieldValue.delete(),
          });
        });
      } catch (releaseError) {
        this.logger.error(
          JSON.stringify({
            event: 'registration_challenge_release_failed',
            emailHash: hashForAudit(email),
            reason: releaseError instanceof Error ? releaseError.message : 'unknown',
          }),
        );
      }
      if (codeValue === 'auth/email-already-exists') {
        throw new ConflictException('This email is already registered. Try logging in.');
      }
      throw error;
    }

    try {
      await this.firebaseAdmin.db().runTransaction(async transaction => {
        const current = await transaction.get(ref);
        if (current.get('creationClaimHash') === claimHash) {
          transaction.delete(ref);
        }
      });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'registration_challenge_cleanup_failed',
          emailHash: hashForAudit(email),
          reason: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }
    await this.recordAccountSecurityActivity(
      createdUid,
      email,
      'email_verified',
    );
    return { success: true, verified: true, message: 'Email verified and account created.' };
  }

  private async recordAccountSecurityActivity(
    uid: string,
    email: string,
    eventType: AccountSecurityActivityType,
  ) {
    try {
      await this.securityEvents.recordAccountActivity({ uid, email, eventType });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'account_activity_record_failed',
          activity: eventType,
          uidHash: hashForAudit(uid),
          reason: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }
  }

  private readBearerToken(authorization: string | undefined): string {
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Firebase ID token.');
    }
    return authorization.slice('Bearer '.length).trim();
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

  private async recordSignedOutActivity(
    request: Request,
    eventType: 'signed_out' | 'sessions_revoked',
  ) {
    const sessionCookie = request.cookies?.[SESSION_COOKIE_NAME];
    if (!sessionCookie) return;

    try {
      const decoded = await this.firebaseAdmin
        .auth()
        .verifySessionCookie(sessionCookie, false);
      if (decoded.uid && decoded.email) {
        await this.recordAccountSecurityActivity(
          decoded.uid,
          decoded.email,
          eventType,
        );
      }
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'account_activity_record_failed',
          activity: eventType,
          reason: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }
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
      throw new UnauthorizedException(
        'No shared session was available to revoke. Sign in again and retry to sign-out.',
      );
    }

    const decoded = await this.firebaseAdmin
      .auth()
      .verifySessionCookie(sessionCookie, false);
    if (!decoded.uid) {
      throw new UnauthorizedException('The shared session could not be verified.');
    }

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
        fullname: '',
        firstName: '',
        lastName: '',
        profilePicture: '',
        bio: '',
        website: '',
        location: '',
        country: '',
        countryCode: '',
        detectedCountryCode: '',
        detectedCountrySource: '',
        detectedCountryUpdatedAt: null,
        createdAt: null,
        lastLoginAt: null,
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
    const fullname = this.stringValue(data.fullname);
    const roles = data.roles;
    const emailPreferences = this.normalizeEmailPreferences(
      data.emailPreferences,
    );
    return {
      fullname,
      firstName: this.stringValue(data.firstName),
      lastName: this.stringValue(data.lastName),
      phone: this.stringValue(data.phone),
      website: this.stringValue(data.website),
      location: this.stringValue(data.location),
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
      createdAt: this.timestampToIso(data.createdAt),
      lastLoginAt: this.timestampToIso(data.lastLoginAt),
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
      updates.privacy = this.normalizePrivacyUpdates(profile.privacy);
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

  private normalizePrivacyUpdates(value: unknown) {
    const privacy =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const updates: Record<string, boolean> = {};

    for (const key of [
      'publicProfile',
      'showCompletedCourses',
      'showCountry',
      'personalizedAiRecommendations',
    ]) {
      if (typeof privacy[key] === 'boolean') {
        updates[key] = privacy[key] as boolean;
      }
    }

    return updates;
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
    const nameParts = name.trim().split(/\s+/).filter(Boolean);
    const firstName =
      typeof existingUser?.firstName === 'string'
        ? existingUser.firstName
        : nameParts[0] || '';
    const lastName =
      typeof existingUser?.lastName === 'string'
        ? existingUser.lastName
        : nameParts.slice(1).join(' ');
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
        firstName,
        lastName,
        name: FieldValue.delete(),
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
    try {
      await this.securityEvents.recordAccountActivity({
        uid: decodedToken.uid,
        email,
        eventType: 'signed_in',
      });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'account_activity_record_failed',
          activity: 'signed_in',
          uidHash: hashForAudit(decodedToken.uid),
          reason: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }
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

  private normalizeFirebasePhoneNumber(input: string): string | null {
    const raw = input.trim();
    if (!raw) {
      return null;
    }

    const compact = raw.replace(/\s+/g, '');
    const digitsOnly = compact.replace(/\D/g, '');

    if (!digitsOnly || digitsOnly.length < 8 || digitsOnly.length > 15) {
      return null;
    }

    if (compact.startsWith('+')) {
      return `+${digitsOnly}`;
    }

    if (compact.startsWith('27')) {
      return `+${digitsOnly}`;
    }

    if (compact.startsWith('0')) {
      return `+27${digitsOnly.slice(1)}`;
    }

    return null;
  }

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

  private async enforceAuthRateLimit(email: string, ip: string) {
    const windowMs = 15 * 60 * 1_000; // 15 minutes

    const [byEmail, byIp] = await Promise.all([
      this.runtimeLimits.reserve({
        collection: 'runtime_auth_rate_limits',
        key: `email:${email}`,
        limit: 5,
        windowMs,
      }),
      this.runtimeLimits.reserve({
        collection: 'runtime_auth_rate_limits',
        key: `ip:${ip}`,
        limit: 20,
        windowMs,
      }),
    ]);

    if (byEmail.limited || byIp.limited) {
      const retryAfter = Math.max(
        byEmail.retryAfterSeconds,
        byIp.retryAfterSeconds,
      );

      this.logger.warn(
        JSON.stringify({
          event: 'auth_rate_limit_denied',
          reason: byEmail.limited ? 'per_email' : 'per_ip',
          ipHash: hashForAudit(ip),
          emailHash: hashForAudit(email),
          retryAfterSeconds: retryAfter,
        }),
      );

      throw new HttpException(
        {
          statusCode: 429,
          error: 'Too Many Requests',
          message: `Too many login attempts. Please try again in ${retryAfter} seconds.`,
          retryAfter,
        },
        429,
      );
    }
  }

  private async isFlowSessionAllowed(email?: string | null) {
    const normalized = normalizeEmailAddress(email || '');
    if (!normalized) return false;

    if (isFlowAllowedEmail(normalized)) return true;

    try {
      const doc = await this.firebaseAdmin
        .db()
        .collection('flowAllowedEmails')
        .doc(normalized.replace(/[.#$/\[\]]/g, '_'))
        .get();

      if (doc.exists && String((doc.data() || {}).status || '') === 'active') {
        return true;
      }
    } catch {
      // Ignore Firestore check failures
    }

    return false;
  }
}
