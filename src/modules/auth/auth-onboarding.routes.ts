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
  hashDevicePollSecret,
  isDeviceAuthExpired,
  matchesDevicePollSecret,
  normalizeDeviceCode,
  resolveDeviceAuthPollResult,
} from './device-auth';
import { FirebaseDecodedToken, ProfileUpdateBody,AcademyProfileUpdate,ProfilePictureUpdate,SignInAlertDecision } from './auth-controller.types';
import { AuthSecurityRoutes } from './auth-security.routes';

export abstract class AuthOnboardingRoutes extends AuthSecurityRoutes {
  @Post('device/start')
  async startDeviceAuth(@Req() request: Request) {
    const challenge = buildDeviceAuthChallenge();

    const deviceKey = `device_auth:${normalizeDeviceCode(challenge.deviceCode)}`;
    const sessionPayload = {
      deviceCode: challenge.deviceCode,
      userCode: challenge.userCode,
      pollSecretHash: hashDevicePollSecret(challenge.pollSecret),
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
      pollSecret: challenge.pollSecret,
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

    await this.enforceAuthRateLimit(email, request.ip || 'unknown', 3);

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
      const errorBody = (await signInRes.json().catch(() => ({}))) as {
        error?: { message?: string };
        mfaPendingCredential?: string;
        mfaInfo?: Array<{
          mfaEnrollmentId?: string;
          displayName?: string;
          totpInfo?: Record<string, unknown>;
        }>;
      };
      if (errorBody.mfaPendingCredential) {
        const mfaInfo = (errorBody.mfaInfo || [])
          .filter(factor => Boolean(factor.totpInfo))
          .map(factor => ({
            mfaEnrollmentId: factor.mfaEnrollmentId || '',
            displayName: factor.displayName || '',
            factorId: 'totp',
          }));
        if (!mfaInfo.some(factor => factor.mfaEnrollmentId)) {
          throw new UnauthorizedException('No supported second factor is enrolled for this account.');
        }
        return {
          mfaRequired: true,
          mfaPendingCredential: errorBody.mfaPendingCredential,
          mfaInfo,
        };
      }
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

  @Post('device/mfa-complete')
  @HttpCode(200)
  async completeDeviceMfaAuth(
    @Body()
    body: {
      deviceCode?: string;
      userCode?: string;
      email?: string;
      mfaPendingCredential?: string;
      mfaEnrollmentId?: string;
      verificationCode?: string;
    },
    @Req() request: Request,
  ) {
    const deviceCode = normalizeDeviceCode(body.deviceCode);
    const userCode = normalizeDeviceCode(body.userCode);
    const email = String(body.email || '').trim().toLowerCase();
    const mfaPendingCredential = String(body.mfaPendingCredential || '');
    const mfaEnrollmentId = String(body.mfaEnrollmentId || '');
    const verificationCode = String(body.verificationCode || '').trim();
    if (
      !deviceCode ||
      !userCode ||
      !email ||
      !mfaPendingCredential ||
      !mfaEnrollmentId ||
      !/^\d{6}$/.test(verificationCode)
    ) {
      throw new BadRequestException('Complete all required device and authenticator fields.');
    }

    await this.enforceAuthRateLimit(email, request.ip || 'unknown', 3);

    const ref = this.firebaseAdmin.db().collection('device_auth_sessions').doc(`device_auth:${deviceCode}`);
    const snapshot = await ref.get();
    if (!snapshot.exists) throw new BadRequestException('Unknown or expired device code.');
    const record = snapshot.data() as {
      userCode?: string;
      status?: string;
      createdAt?: number;
      expiresAt?: number;
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

    const mfaResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v2/accounts/mfaSignIn:finalize?key=${encodeURIComponent(this.getFirebaseWebApiKey())}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mfaPendingCredential,
          mfaEnrollmentId,
          totpVerificationInfo: { verificationCode },
        }),
      },
    );
    const result = (await mfaResponse.json().catch(() => ({}))) as {
      idToken?: string;
      localId?: string;
      email?: string;
      error?: { message?: string };
    };
    if (!mfaResponse.ok || !result.idToken) {
      throw new UnauthorizedException(result.error?.message || 'The authenticator code is incorrect or expired.');
    }
    const decoded = await this.firebaseAdmin.auth().verifyIdToken(result.idToken, true);
    if (
      decoded.email?.toLowerCase() !== email ||
      result.email?.toLowerCase() !== email ||
      decoded.uid !== result.localId
    ) {
      throw new UnauthorizedException('The authenticator sign-in did not match the requested account.');
    }

    await ref.set({
      status: 'approved',
      uid: decoded.uid,
      email,
      idToken: result.idToken,
      approvedAt: Date.now(),
    }, { merge: true });
    return { ok: true, status: 'approved', email };
  }

  @Post('device/status')
  async getDeviceAuthStatus(
    @Body() body: { deviceCode?: string; pollSecret?: string },
  ) {
    const deviceCode = normalizeDeviceCode(body.deviceCode);
    const pollSecret = typeof body.pollSecret === 'string' ? body.pollSecret : '';
    if (!deviceCode || pollSecret.length < 32) {
      throw new BadRequestException('Device polling credentials are required.');
    }

    const ref = this.firebaseAdmin.db().collection('device_auth_sessions').doc(`device_auth:${deviceCode}`);
    return this.firebaseAdmin.db().runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return { ok: true, status: 'expired' };

      const record = snapshot.data() as {
        status?: string;
        createdAt?: number;
        expiresAt?: number;
        pollSecretHash?: string;
        token?: string;
        idToken?: string;
        email?: string;
        credentialClaimedAt?: unknown;
      };
      if (
        !record.pollSecretHash ||
        !matchesDevicePollSecret(pollSecret, record.pollSecretHash)
      ) {
        throw new UnauthorizedException('Invalid device polling credentials.');
      }

      if (
        isDeviceAuthExpired({
          createdAt: Number(record.createdAt || Date.now()),
          expiresAt: Number(record.expiresAt || Date.now()),
        })
      ) {
        transaction.update(ref, {
          status: 'expired',
          token: FieldValue.delete(),
          idToken: FieldValue.delete(),
        });
        return { ok: true, status: 'expired' };
      }

      const result = resolveDeviceAuthPollResult(record);
      if (result.kind !== 'approved') {
        return { ok: true, status: result.status };
      }
      if (!result.token) {
        throw new InternalServerErrorException(
          'Approved device authorization has no credential to claim.',
        );
      }

      transaction.update(ref, {
        token: FieldValue.delete(),
        idToken: FieldValue.delete(),
        credentialClaimedAt: FieldValue.serverTimestamp(),
      });
      return {
        ok: true,
        status: result.status,
        email: result.email,
        token: result.token,
      };
    });
  }

  @Post('email-verification/send')
  @HttpCode(200)
  async sendEmailVerificationCode(
    @Body() body: { email?: string; userName?: string; appId?: string },
    @Req() request: Request,
  ) {
    if (typeof body.email !== 'string' || !body.email.trim()) {
      throw new BadRequestException(
        'Email address was not included. Refresh the registration page and try again.',
      );
    }
    const email = body.email.trim().toLowerCase();
    if (email.length > 254 || !isEmail(email)) {
      throw new BadRequestException('Enter a valid email address.');
    }
    const appId = body.appId?.trim().toLowerCase();
    const requestedAppId = appId
      ? this.appsService.resolveId(appId)
      : null;
    if (appId && !requestedAppId && appId !== 'infinity') {
      throw new BadRequestException('Unknown application for email verification.');
    }
    const appName = appId === 'infinity'
      ? 'Infinity'
      : requestedAppId
        ? this.appsService.list().find(app => app.id === requestedAppId)?.name ||
          'Chefu Technologies'
        : 'Chefu Technologies';
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
    const sendLimitRef = this.firebaseAdmin.db()
      .collection('email_verification_send_limits')
      .doc(createHash('sha256').update(email).digest('hex'));
    const now = Date.now();

    const sendResult = await this.firebaseAdmin.db().runTransaction(async transaction => {
      const [existing, sendLimit] = await Promise.all([
        transaction.get(ref),
        transaction.get(sendLimitRef),
      ]);
      const data = existing.data() as {
        status?: string;
        creationClaimExpiresAt?: Timestamp | Date;
      } | undefined;
      const claimExpiresAt = data?.creationClaimExpiresAt instanceof Date
        ? data.creationClaimExpiresAt.getTime()
        : data?.creationClaimExpiresAt?.toMillis() ?? 0;
      if (data?.status === 'creating' && claimExpiresAt > now) {
        throw new ConflictException('Registration is already being completed.');
      }

      const limitData = sendLimit.data() as { sentAtMs?: number[] } | undefined;
      const recentSends = (Array.isArray(limitData?.sentAtMs) ? limitData.sentAtMs : [])
        .filter(sentAt => Number.isFinite(sentAt) && sentAt > now - 24 * 60 * 60_000)
        .sort((left, right) => left - right);
      if (recentSends.length >= 4) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((recentSends[0] + 24 * 60 * 60_000 - now) / 1000),
        );
        throw new HttpException(
          {
            statusCode: 429,
            message: 'Daily verification email limit reached. Please try again later.',
            retryAfterSeconds,
            resendsRemaining: 0,
          },
          429,
        );
      }

      const cooldownBySendCountMs = [0, 60_000, 150_000, 300_000];
      const requiredCooldownMs = cooldownBySendCountMs[recentSends.length];
      const retryAfterMs = recentSends.length
        ? recentSends[recentSends.length - 1] + requiredCooldownMs - now
        : 0;
      if (retryAfterMs > 0) {
        throw new HttpException(
          {
            statusCode: 429,
            message: 'Please wait before requesting another verification code.',
            retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
            resendsRemaining: Math.max(0, 3 - Math.max(0, recentSends.length - 1)),
          },
          429,
        );
      }

      transaction.set(ref, {
        email,
        userName: String(body.userName || '').trim().slice(0, 120) || null,
        appName,
        codeHash,
        expiresAt: Timestamp.fromMillis(now + 10 * 60_000),
        lastSentAt: Timestamp.fromMillis(now),
        attempts: 0,
        status: 'pending',
      });
      const updatedSends = [...recentSends, now];
      transaction.set(sendLimitRef, {
        sentAtMs: updatedSends,
        expiresAt: Timestamp.fromMillis(now + 24 * 60 * 60_000),
      });
      const cooldownSeconds =
        cooldownBySendCountMs[updatedSends.length] === undefined
          ? 0
          : cooldownBySendCountMs[updatedSends.length] / 1000;
      return {
        cooldownSeconds,
        resendsRemaining: Math.max(0, 3 - Math.max(0, updatedSends.length - 1)),
      };
    });

    try {
      await this.resendService.sendEmailVerification({
        email,
        userName: String(body.userName || '').trim().slice(0, 120) || undefined,
        code,
        expiresIn: '10 minutes',
        appName,
      });
    } catch (error) {
      await this.firebaseAdmin.db().runTransaction(async transaction => {
        const current = await transaction.get(ref);
        if (current.get('codeHash') === codeHash) transaction.delete(ref);
      });
      throw error;
    }

    return {
      success: true,
      message: 'Verification code sent to your email.',
      ...sendResult,
    };
  }

  @Post('password-reset/request')
  @HttpCode(200)
  async requestPasswordReset(
    @Body() body: { email?: string; appId?: string; returnTo?: string },
    @Req() request: Request,
  ) {
    if (typeof body.email !== 'string' || !body.email.trim()) {
      throw new BadRequestException('Email address is required.');
    }
    const email = body.email.trim().toLowerCase();
    if (email.length > 254 || !isEmail(email)) {
      throw new BadRequestException('Enter a valid email address.');
    }

    const requestedAppId = body.appId?.trim().toLowerCase();
    if (
      requestedAppId &&
      !this.appsService.resolveId(requestedAppId) &&
      requestedAppId !== 'infinity'
    ) {
      throw new BadRequestException('Unknown application for password reset.');
    }

    await this.enforceAuthRateLimit(email, request.ip || 'unknown', 5);

    let response: globalThis.Response;
    try {
      response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(this.getFirebaseWebApiKey())}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestType: 'PASSWORD_RESET',
            email,
          }),
        },
      );
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'password_reset_request_failed',
          emailHash: hashForAudit(email),
          reason: error instanceof Error ? error.message : 'upstream_unavailable',
        }),
      );
      throw new BadGatewayException('Unable to send a password reset email right now.');
    }

    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as {
        error?: { message?: string; status?: string };
      };
      const errorCode = result.error?.message || result.error?.status || '';
      if (response.status === 400) {
        this.logger.warn(
          JSON.stringify({
            event: 'password_reset_request_not_accepted',
            upstreamErrorCode: /^[A-Z0-9_]+$/.test(errorCode) ? errorCode : null,
            emailHash: hashForAudit(email),
          }),
        );
        return {
          success: true,
          message: 'If an account exists for this email, a reset email is on its way.',
        };
      }

      this.logger.error(
        JSON.stringify({
          event: 'password_reset_request_failed',
          upstreamStatus: response.status,
          upstreamErrorCode: /^[A-Z0-9_]+$/.test(errorCode) ? errorCode : null,
          emailHash: hashForAudit(email),
        }),
      );
      if (response.status === 429) {
        throw new HttpException(
          'Too many password reset requests. Please try again later.',
          429,
        );
      }
      throw new BadGatewayException('Unable to send a password reset email right now.');
    }

    return {
      success: true,
      message: 'If an account exists for this email, a reset email is on its way.',
    };
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
    @Headers(CHEFU_APP_HEADER) chefuApp: string | undefined,
    @Headers(FLOW_SESSION_HEADER) flowSession: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (typeof body.email !== 'string' || !body.email.trim()) {
      throw new BadRequestException('Email address is required.');
    }
    const email = body.email.trim().toLowerCase();
    const sessionAppId = this.resolveSessionAppId(chefuApp, flowSession);
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
        appName?: string;
        userName?: string;
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
      if (Number(data.attempts || 0) >= 3) {
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
        if (attempts >= 3) transaction.delete(ref);
        else transaction.update(ref, { attempts });
        return { result: 'invalid' as const, attemptsRemaining: Math.max(0, 3 - attempts) };
      }

      transaction.update(ref, {
        status: 'creating',
        creationClaimHash: claimHash,
        creationClaimExpiresAt: Timestamp.fromMillis(now + 2 * 60_000),
      });
      return {
        result: 'claimed' as const,
        attemptsRemaining: 3,
        appName: data.appName || 'Chefu Technologies',
        userName: data.userName || displayName,
      };
    });

    if (claimResult === 'missing') {
      throw new BadRequestException('No active verification code found.');
    }
    if (claimResult === 'expired') {
      throw new BadRequestException('Verification code has expired.');
    }
    if (claimResult === 'locked') {
      throw new HttpException(
        {
          statusCode: 400,
          message: 'Too many incorrect codes. Request a new code.',
          attemptsRemaining: 0,
        },
        400,
      );
    }
    if (claimResult === 'in-progress') {
      throw new ConflictException('Registration is already being completed.');
    }
    if (claimResult.result === 'invalid') {
      throw new HttpException(
        {
          statusCode: 400,
          message: 'Incorrect verification code.',
          attemptsRemaining: claimResult.attemptsRemaining,
        },
        400,
      );
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

    const signupAlertSuppressionExpiresAt = Timestamp.fromMillis(
      Date.now() + 5 * 60_000,
    );
    try {
      await this.firebaseAdmin.db()
        .collection('users')
        .doc(email)
        .set(
          { signupSignInAlertSuppressionExpiresAt: signupAlertSuppressionExpiresAt },
          { merge: true },
        );
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'signup_sign_in_alert_suppression_write_failed',
          emailHash: hashForAudit(email),
          reason: error instanceof Error ? error.message : 'unknown',
        }),
      );
    }

    const signupCustomToken = await this.firebaseAdmin.auth().createCustomToken(
      createdUid,
      { chefu_auth_provider: 'password' },
    );
    const signupIdToken = await this.exchangeCustomTokenForIdToken(
      signupCustomToken,
    );
    await this.createSession(
      `Bearer ${signupIdToken}`,
      chefuApp,
      flowSession,
      request,
      response,
      true,
      true,
    );

    try {
      await this.resendService.sendSignupWelcomeEmail({
        email,
        userName: claimResult.userName,
        appName: claimResult.appName,
      });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'signup_welcome_email_failed',
          emailHash: hashForAudit(email),
          reason: error instanceof Error ? error.message : 'unknown',
        }),
      );
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
    return {
      success: true,
      verified: true,
      message: 'Email verified and account created.',
      app: sessionAppId,
    };
  }

  private readBearerToken(authorization: string | undefined): string {
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Firebase ID token.');
    }
    return authorization.slice('Bearer '.length).trim();
  }

}
