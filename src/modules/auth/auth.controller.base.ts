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
import {
  auditRequestContext,
  getClientIp as getTrustedClientIp,
  hashForAudit,
} from '../../common/security-audit';
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
  isTrustedDeviceInvalidatedByCredentialChange,
  isDeviceAuthExpired,
  normalizeDeviceCode,
} from './device-auth';
import { FirebaseDecodedToken, ProfileUpdateBody,AcademyProfileUpdate,ProfilePictureUpdate,SignInAlertDecision } from './auth-controller.types';

export const TRUSTED_DEVICE_COOKIE_NAME = 'chefu_trusted_device';
export const TRUSTED_DEVICE_CHALLENGE_COOKIE_NAME = 'chefu_trusted_device_challenge';
export const TRUSTED_DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const TRUSTED_DEVICE_CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const TRUSTED_DEVICE_CODE_MAX_ATTEMPTS = 5;
const TRUSTED_DEVICE_EMAIL_SEND_COOLDOWNS_MS = [0, 60_000, 150_000, 300_000];
const TRUSTED_DEVICE_EMAIL_MAX_SENDS_PER_DAY = 4;

export function decodeJwtPayload(token: string) {
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
      chefu_auth_provider?: string;
      firebase?: {
        sign_in_provider?: string;
        sign_in_second_factor?: string;
      };
    };
  } catch {
    return null;
  }
}



export class AuthControllerBase {
  protected readonly logger = new Logger('AuthController');

  constructor(
    @Inject(FirebaseAdminService)
    protected readonly firebaseAdmin: FirebaseAdminService,
    @Inject(SessionSignerService)
    protected readonly sessionSigner: SessionSignerService,
    @Inject(MfaBackupCodeService)
    protected readonly mfaBackupCodes: MfaBackupCodeService,
    @Inject(ResendService)
    protected readonly resendService: ResendService,
    @Inject(AppsService)
    protected readonly appsService: AppsService,
    @Inject(SecurityEventsService)
    protected readonly securityEvents: SecurityEventsService,
    @Inject(RuntimeLimitService)
    protected readonly runtimeLimits: RuntimeLimitService,
    @Inject(ProfilePictureService)
    protected readonly profilePictureService: ProfilePictureService,
    @Inject(PasskeyService)
    protected readonly passkeyService: PasskeyService,
  ) {}

  protected async recordSignedOutActivity(
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

  protected async recordAccountSecurityActivity(
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

  protected buildSessionMeta({
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

  protected assertRecentFirebaseSignIn(authTime?: number) {
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

  protected async revokeCurrentSession(request: Request) {
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

  protected async recordSessionRevocation(email: string | undefined, uid: string) {
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

  protected async revokeCredentialSessions(
    uid: string,
    email: string | undefined,
    reason: 'password_changed' | 'mfa_disabled',
  ) {
    await this.firebaseAdmin.auth().revokeRefreshTokens(uid);
    await Promise.all([
      this.recordSessionRevocation(email, uid),
      this.securityEvents.publishSubjectRevocation({
        actor: uid,
        email,
        reason,
        uid,
      }),
      this.revokeTrustedAuthDevices(uid),
    ]);
  }

  protected async revokeTrustedAuthDevices(uid: string) {
    const collection = this.firebaseAdmin.db().collection('auth_trusted_devices');
    const snapshot = await collection.where('uid', '==', uid).get();
    for (let offset = 0; offset < snapshot.docs.length; offset += 400) {
      const batch = this.firebaseAdmin.db().batch();
      for (const document of snapshot.docs.slice(offset, offset + 400)) {
        batch.update(document.ref, {
          revokedAt: Timestamp.now(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
    }
  }

  protected async revokeTrustedDevicesInvalidatedByCredentialChange(uid: string) {
    const authUser = await this.firebaseAdmin.auth().getUser(uid);
    const validAfterMs = Date.parse(authUser.tokensValidAfterTime || '');
    if (!Number.isFinite(validAfterMs)) return;

    const collection = this.firebaseAdmin.db().collection('auth_trusted_devices');
    const snapshot = await collection.where('uid', '==', uid).get();
    const invalidated = snapshot.docs.filter(document =>
      isTrustedDeviceInvalidatedByCredentialChange(
        this.timestampToMillis(document.data().createdAt),
        validAfterMs,
      ),
    );
    for (let offset = 0; offset < invalidated.length; offset += 400) {
      const batch = this.firebaseAdmin.db().batch();
      for (const document of invalidated.slice(offset, offset + 400)) {
        batch.update(document.ref, {
          revokedAt: Timestamp.now(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
    }
  }

  protected clearSessionCookies(response: Response) {
    for (const options of this.getClearCookieOptionsList()) {
      response.clearCookie(SESSION_COOKIE_NAME, options);
      response.clearCookie(SESSION_META_COOKIE_NAME, options);
      response.clearCookie(TRUSTED_DEVICE_CHALLENGE_COOKIE_NAME, options);
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

  protected async isTrustedAuthDevice(uid: string, request: Request) {
    const token = request.cookies?.[TRUSTED_DEVICE_COOKIE_NAME];
    if (typeof token !== 'string' || token.length < 32) return false;

    await this.revokeTrustedDevicesInvalidatedByCredentialChange(uid);
    const ref = this.firebaseAdmin.db()
      .collection('auth_trusted_devices')
      .doc(createHash('sha256').update(token).digest('hex'));
    return this.firebaseAdmin.db().runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      const device = snapshot.data() as {
        uid?: string;
        expiresAt?: Timestamp;
        revokedAt?: Timestamp | null;
      } | undefined;
      if (
        !snapshot.exists ||
        device?.uid !== uid ||
        device.revokedAt ||
        this.timestampToMillis(device.expiresAt) <= Date.now()
      ) {
        return false;
      }

      transaction.update(ref, {
        lastSeenAt: FieldValue.serverTimestamp(),
        lastSeenAtMs: Date.now(),
      });
      return true;
    });
  }

  protected trustedDeviceName(userAgent: string) {
    if (!userAgent) return 'Unknown device';
    const browser = /Edg\//.test(userAgent)
      ? 'Microsoft Edge'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : 'Browser';
    const platform = /iPhone|iPad/.test(userAgent)
      ? 'iPhone or iPad'
      : /Android/.test(userAgent)
        ? 'Android device'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Macintosh|Mac OS/.test(userAgent)
            ? 'Mac'
            : /Linux/.test(userAgent)
              ? 'Linux'
              : 'device';
    return `${browser} on ${platform}`;
  }

  protected async issueTrustedDeviceEmailChallenge({
    uid,
    email,
    userName,
    request,
    response,
  }: {
    uid: string;
    email: string;
    userName: string;
    request: Request;
    response: Response;
  }): Promise<{ cooldownSeconds: number; resendsRemaining: number }> {
    const code = String(randomInt(100000, 1000000));
    const challengeToken = randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = Timestamp.fromMillis(now + TRUSTED_DEVICE_CHALLENGE_TTL_MS);
    const db = this.firebaseAdmin.db();
    const challengeRef = db
      .collection('auth_trusted_device_challenges')
      .doc(uid);
    const sendLimitRef = db
      .collection('auth_trusted_device_send_limits')
      .doc(uid);
    const sendResult = await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(sendLimitRef);
      const limit = snapshot.data() as { sentAtMs?: number[] } | undefined;
      const recentSends = (Array.isArray(limit?.sentAtMs) ? limit.sentAtMs : [])
        .filter(sentAt => Number.isFinite(sentAt) && sentAt > now - 24 * 60 * 60_000)
        .sort((left, right) => left - right);
      if (recentSends.length >= TRUSTED_DEVICE_EMAIL_MAX_SENDS_PER_DAY) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((recentSends[0] + 24 * 60 * 60_000 - now) / 1000),
        );
        throw new HttpException(
          {
            statusCode: 429,
            message: 'Daily trusted-device email limit reached. Please try again later.',
            retryAfterSeconds,
            resendsRemaining: 0,
          },
          429,
        );
      }

      const requiredCooldownMs =
        TRUSTED_DEVICE_EMAIL_SEND_COOLDOWNS_MS[recentSends.length];
      const retryAfterMs = recentSends.length
        ? recentSends[recentSends.length - 1] + requiredCooldownMs - now
        : 0;
      if (retryAfterMs > 0) {
        throw new HttpException(
          {
            statusCode: 429,
            message: 'Please wait before requesting another trusted-device code.',
            retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
            resendsRemaining: Math.max(0, 3 - Math.max(0, recentSends.length - 1)),
          },
          429,
        );
      }

      const updatedSends = [...recentSends, now];
      transaction.set(sendLimitRef, {
        sentAtMs: updatedSends,
        expiresAt: Timestamp.fromMillis(now + 24 * 60 * 60_000),
      });
      transaction.set(challengeRef, {
        uid,
        codeHash: this.trustedDeviceCodeHash(uid, code),
        challengeTokenHash: createHash('sha256').update(challengeToken).digest('hex'),
        attempts: 0,
        expiresAt,
        emailHash: hashForAudit(email),
        userAgentHash: this.hashValue(request.headers['user-agent'] || 'unknown'),
        createdAt: FieldValue.serverTimestamp(),
      });
      return {
        cooldownSeconds:
          TRUSTED_DEVICE_EMAIL_SEND_COOLDOWNS_MS[updatedSends.length] === undefined
            ? 0
            : TRUSTED_DEVICE_EMAIL_SEND_COOLDOWNS_MS[updatedSends.length] / 1000,
        resendsRemaining: Math.max(0, 3 - Math.max(0, updatedSends.length - 1)),
      };
    });
    await this.resendService.sendEmailVerification({
      email,
      userName,
      code,
      expiresIn: '10 minutes',
      appName: 'Chefu Technologies',
    });
    response.cookie(TRUSTED_DEVICE_CHALLENGE_COOKIE_NAME, challengeToken, {
      ...this.getCookieOptions(),
      maxAge: TRUSTED_DEVICE_CHALLENGE_TTL_MS,
    });
    return sendResult;
  }

  protected trustedDeviceCodeHash(uid: string, code: string) {
    const secret =
      process.env.AUTH_SESSION_SECRET ||
      process.env.SESSION_COOKIE_SECRET ||
      process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!secret) {
      throw new InternalServerErrorException(
        'Trusted-device verification is not configured.',
      );
    }
    return createHmac('sha256', secret).update(`${uid}:${code}`).digest('hex');
  }

  protected async rememberTrustedAuthDevice({
    uid,
    request,
    response,
    source,
  }: {
    uid: string;
    request: Request;
    response: Response;
    source: 'signup' | 'explicit_choice';
  }) {
    const db = this.firebaseAdmin.db();
    const collection = db.collection('auth_trusted_devices');
    const suppliedToken = request.cookies?.[TRUSTED_DEVICE_COOKIE_NAME];
    let token = randomBytes(32).toString('base64url');
    let ref = collection.doc(createHash('sha256').update(token).digest('hex'));
    let createdAt: unknown;
    let alreadyTrusted = false;
    if (typeof suppliedToken === 'string' && suppliedToken.length >= 32) {
      const suppliedRef = collection.doc(
        createHash('sha256').update(suppliedToken).digest('hex'),
      );
      const snapshot = await suppliedRef.get();
      const suppliedDevice = snapshot.data();
      if (
        snapshot.exists &&
        suppliedDevice?.uid === uid &&
        !suppliedDevice.revokedAt &&
        this.timestampToMillis(suppliedDevice.expiresAt) > Date.now()
      ) {
        token = suppliedToken;
        ref = suppliedRef;
        createdAt = suppliedDevice.createdAt;
        alreadyTrusted = true;
      }
    }
    if (!alreadyTrusted) {
      const existingDevices = await collection.where('uid', '==', uid).get();
      const nowMs = Date.now();
      const activeDocs = existingDevices.docs.filter(document => {
        const device = document.data();
        return !device.revokedAt && this.timestampToMillis(device.expiresAt) > nowMs;
      });
      const inactiveDocs = existingDevices.docs.filter(document => {
        const device = document.data();
        return Boolean(device.revokedAt) || this.timestampToMillis(device.expiresAt) <= nowMs;
      });
      for (let offset = 0; offset < inactiveDocs.length; offset += 400) {
        const cleanup = db.batch();
        for (const document of inactiveDocs.slice(offset, offset + 400)) {
          cleanup.delete(document.ref);
        }
        await cleanup.commit();
      }
      const activeCount = activeDocs.length;
      if (activeCount >= 20) {
        throw new BadRequestException(
          'You have reached the 20 trusted-device limit. Remove a device before trusting another.',
        );
      }
    }

    const now = Date.now();
    await ref.set(
      {
        uid,
        createdAt: createdAt || Timestamp.now(),
        expiresAt: Timestamp.fromMillis(now + TRUSTED_DEVICE_TTL_MS),
        lastSeenAt: FieldValue.serverTimestamp(),
        lastSeenAtMs: now,
        userAgentHash: this.hashValue(request.headers['user-agent'] || 'unknown'),
        userAgent: String(request.headers['user-agent'] || 'Unknown device').slice(0, 300),
        source,
        revokedAt: null,
      },
      { merge: true },
    );
    response.cookie(TRUSTED_DEVICE_COOKIE_NAME, token, {
      ...this.getCookieOptions(),
      maxAge: TRUSTED_DEVICE_TTL_MS,
    });
  }

  protected getCookieOptions() {
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

  protected resolveSessionAppId(
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

    return resolvedAppId || 'root';
  }

  protected async exchangeCustomTokenForIdToken(customToken: string) {
    const apiKey = this.getFirebaseWebApiKey();

    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: customToken, returnSecureToken: true }),
      },
    );
    const result = (await response.json().catch(() => ({}))) as {
      idToken?: string;
      error?: { message?: string };
    };

    if (!response.ok || !result.idToken) {
      this.logger.error(
        JSON.stringify({
          event: 'firebase_custom_token_exchange_failed',
          statusCode: response.status,
          reason: result.error?.message || 'invalid_response',
        }),
      );
      throw new BadGatewayException(
        'Unable to establish your account session. Please try signing in.',
      );
    }

    return result.idToken;
  }

  protected getFirebaseWebApiKey() {
    const apiKey = process.env.FIREBASE_WEB_API_KEY || process.env.FIREBASE_API_KEY;
    if (!apiKey) {
      throw new InternalServerErrorException(
        'Firebase web API key is not configured.',
      );
    }
    return apiKey;
  }

  protected async getReauthenticationSession(token: string | undefined, uid: string) {
    if (!token || token.length < 32) {
      throw new UnauthorizedException('Confirm your password before continuing.');
    }
    const ref = this.firebaseAdmin.db()
      .collection('auth_reauthentication_sessions')
      .doc(createHash('sha256').update(token).digest('hex'));
    const snapshot = await ref.get();
    const session = snapshot.data() as {
      uid?: string;
      idToken?: string;
      expiresAt?: Timestamp;
    } | undefined;
    if (
      !session ||
      session.uid !== uid ||
      !session.idToken ||
      (session.expiresAt?.toMillis() || 0) <= Date.now()
    ) {
      throw new UnauthorizedException('Your sign-in confirmation expired. Please confirm again.');
    }
    return { idToken: session.idToken };
  }

  protected getClearCookieOptionsList() {
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

  protected async getUserProfile(email?: string) {
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


  protected normalizeAcademyProfileUpdates(profile: AcademyProfileUpdate) {
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

  protected normalizeEmailPreferences(value: unknown) {
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

  protected normalizePrivacy(value: unknown) {
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

  protected normalizePrivacyUpdates(value: unknown) {
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

  protected normalizeProfilePictureUpdate(
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

  protected normalizeFirebaseProfilePicture(decodedToken: FirebaseDecodedToken) {
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

  protected normalizeProfilePictureUrl(value: unknown) {
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

  protected hasUnsafeUrlCharacters(value: string) {
    return (
      /%(?:00|0a|0d|5c)/i.test(value) ||
      Array.from(value).some(
        character => character === '\\' || character.charCodeAt(0) < 0x20,
      )
    );
  }

  protected isLocalDevelopmentUrl(url: URL) {
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    );
  }

  protected stringValue(value: unknown) {
    return typeof value === 'string' ? value : '';
  }

  protected numberValue(value: unknown, fallback: number) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  protected enumValue<T extends string>(value: unknown, allowed: T[]) {
    return allowed.includes(value as T) ? (value as T) : null;
  }

  protected normalizeAppProfileSummary(apps: unknown) {
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

  protected timestampToIso(value: unknown) {
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

  protected async recordServerDetectedCountry(
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

  protected serverDetectedCountryUpdates(request?: Request) {
    const detectedCountry = this.getDetectedCountry(request);

    if (!detectedCountry) return {};

    return {
      detectedCountryCode: detectedCountry.code,
      detectedCountrySource: detectedCountry.source,
      detectedCountryUpdatedAt: FieldValue.serverTimestamp(),
    };
  }

  protected getDetectedCountry(request?: Request) {
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

  protected normalizeCountryCode(value?: string) {
    const code = value?.trim().toUpperCase();

    if (!code || code === 'XX' || code === 'T1') return null;
    if (!/^[A-Z]{2}$/.test(code)) return null;

    return code;
  }

  protected async consumeSignupSignInAlertSuppression(email: string) {
    const userRef = this.firebaseAdmin.db()
      .collection('users')
      .doc(email.trim().toLowerCase());

    return this.firebaseAdmin.db().runTransaction(async transaction => {
      const snapshot = await transaction.get(userRef);
      const expiresAt = snapshot.get('signupSignInAlertSuppressionExpiresAt');
      if (!expiresAt) return false;

      const expiresAtMs = expiresAt instanceof Date
        ? expiresAt.getTime()
        : expiresAt instanceof Timestamp
          ? expiresAt.toMillis()
          : 0;
      transaction.update(userRef, {
        signupSignInAlertSuppressionExpiresAt: FieldValue.delete(),
      });
      return expiresAtMs > Date.now();
    });
  }

  protected async ensureUserProfile(
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
    let createdAt = existingUser?.createdAt;
    if (!createdAt) {
      const authUser = await this.firebaseAdmin.auth().getUser(decodedToken.uid);
      const creationTimeMs = Date.parse(authUser.metadata.creationTime);
      if (!Number.isFinite(creationTimeMs)) {
        throw new InternalServerErrorException(
          'Unable to determine the account creation date.',
        );
      }
      createdAt = Timestamp.fromMillis(creationTimeMs);
    }
    const detectedCountry = this.getDetectedCountry(request);
    const firebaseProfilePicture =
      this.normalizeFirebaseProfilePicture(decodedToken);
    const shouldSeedProfilePicture =
      firebaseProfilePicture && !this.stringValue(existingUser?.profilePicture);

    await userRef.set(
      {
        createdAt,
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


  protected async sendThrottledSignInNotification({
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

  protected async reserveSignInAlert({
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

  protected signInAlertFingerprint(provider: string, request: Request) {
    return this.hashValue(
      [
        provider,
        this.ipFingerprintSource(request),
        request.headers['user-agent'] || 'unknown',
      ].join('|'),
    );
  }

  protected ipFingerprintSource(request: Request) {
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

  protected hashValue(value: string) {
    const secret =
      process.env.SIGNIN_ALERT_FINGERPRINT_SECRET ||
      this.firebaseAdmin.projectId() ||
      'chefu-signin-alert';

    return createHash('sha256').update(`${secret}:${value}`).digest('hex');
  }

  protected signInAlertThrottleMs() {
    const configuredMinutes = Number(
      process.env.SIGNIN_ALERT_THROTTLE_MINUTES || 360,
    );
    const safeMinutes = Number.isFinite(configuredMinutes)
      ? Math.min(Math.max(configuredMinutes, 5), 24 * 60)
      : 360;

    return safeMinutes * 60 * 1000;
  }

  protected timestampToMillis(value: unknown) {
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

  protected getClientIp(request: Request) {
    return getTrustedClientIp(request);
  }

  protected normalizeFirebasePhoneNumber(input: string): string | null {
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

  protected async enforceAuthRateLimit(
    email: string,
    ip: string,
    emailLimit = 5,
  ) {
    const windowMs = 15 * 60 * 1_000; // 15 minutes

    const [byEmail, byIp] = await Promise.all([
      this.runtimeLimits.reserve({
        collection: 'runtime_auth_rate_limits',
        key: `email:${email}`,
        limit: emailLimit,
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

  protected async isFlowSessionAllowed(email?: string | null) {
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
