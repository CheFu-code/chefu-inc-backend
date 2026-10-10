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
import { TRUSTED_DEVICE_COOKIE_NAME, TRUSTED_DEVICE_CHALLENGE_COOKIE_NAME, TRUSTED_DEVICE_TTL_MS, TRUSTED_DEVICE_CHALLENGE_TTL_MS, TRUSTED_DEVICE_CODE_MAX_ATTEMPTS } from './auth.controller.base';
import { AuthSessionRoutes } from './auth-session.routes';

const ACCOUNT_DELETION_CODE_TTL_MS = 10 * 60_000;
const ACCOUNT_DELETION_PROOF_TTL_MS = 20 * 60_000;
const ACCOUNT_DELETION_SEND_COOLDOWNS_MS = [0, 60_000, 150_000, 300_000];
const ACCOUNT_DELETION_MAX_EMAILS_PER_DAY = 4;
const ACCOUNT_DELETION_CHALLENGE_COOKIE_NAME = 'chefu_account_deletion_challenge';

export abstract class AuthSecurityRoutes extends AuthSessionRoutes {
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

  @Get('trusted-devices')
  @UseGuards(AuthGuard)
  async listTrustedDevices(
    @Req() request: Request & { user?: AuthenticatedUser },
  ) {
    const uid = request.user?.uid;
    if (!uid) throw new UnauthorizedException('Authentication required.');
    await this.revokeTrustedDevicesInvalidatedByCredentialChange(uid);
    const snapshot = await this.firebaseAdmin.db()
      .collection('auth_trusted_devices')
      .where('uid', '==', uid)
      .get();
    const now = Date.now();
    return {
      devices: snapshot.docs
        .map(document => ({ id: document.id, data: document.data() }))
        .filter(device =>
          !device.data.revokedAt &&
          this.timestampToMillis(device.data.expiresAt) > now,
        )
        .sort(
          (left, right) =>
            this.timestampToMillis(right.data.lastSeenAt) -
            this.timestampToMillis(left.data.lastSeenAt),
        )
        .map(device => ({
          id: device.id,
          deviceName: this.trustedDeviceName(
            typeof device.data.userAgent === 'string' ? device.data.userAgent : '',
          ),
          createdAt: this.timestampToMillis(device.data.createdAt),
          lastSeenAt: this.timestampToMillis(device.data.lastSeenAt),
          expiresAt: this.timestampToMillis(device.data.expiresAt),
          isCurrent: request.cookies?.[TRUSTED_DEVICE_COOKIE_NAME]
            ? createHash('sha256')
                .update(request.cookies[TRUSTED_DEVICE_COOKIE_NAME])
                .digest('hex') === device.id
            : false,
        })),
    };
  }

  @Delete('trusted-devices')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async revokeTrustedDevices(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Res({ passthrough: true }) response: Response,
    @Body() body: { deviceId?: string; all?: boolean; reauthToken?: string },
  ) {
    const uid = request.user?.uid;
    if (!uid) throw new UnauthorizedException('Authentication required.');
    await this.getReauthenticationSession(body.reauthToken, uid);
    const collection = this.firebaseAdmin.db().collection('auth_trusted_devices');
    const snapshot = await collection.where('uid', '==', uid).get();
    const selected = body.all
      ? snapshot.docs
      : snapshot.docs.filter(document => document.id === body.deviceId);
    if (!body.all && (!body.deviceId || selected.length !== 1)) {
      throw new BadRequestException('Trusted device was not found.');
    }
    if (!selected.length) return { revoked: 0 };

    const batch = this.firebaseAdmin.db().batch();
    const now = Timestamp.now();
    for (const document of selected) {
      batch.update(document.ref, {
        revokedAt: now,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();

    const currentToken = request.cookies?.[TRUSTED_DEVICE_COOKIE_NAME];
    const currentDeviceId =
      typeof currentToken === 'string'
        ? createHash('sha256').update(currentToken).digest('hex')
        : '';
    if (body.all || selected.some(document => document.id === currentDeviceId)) {
      for (const options of this.getClearCookieOptionsList()) {
        response.clearCookie(TRUSTED_DEVICE_COOKIE_NAME, options);
      }
    }
    return { revoked: selected.length };
  }

  @Post('account-deletion/email-challenge')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async sendAccountDeletionEmailCode(
    @Req() request: Request & { user?: AuthenticatedUser; cookies?: Record<string, string> },
    @Res({ passthrough: true }) response: Response,
    @Body() body: { reauthToken?: string; acknowledged?: boolean },
  ) {
    const user = request.user;
    if (!user?.uid || !user.email) throw new UnauthorizedException('Authentication required.');
    if (body.acknowledged !== true) {
      throw new BadRequestException('Acknowledge the account deletion consequences first.');
    }

    const authUser = await this.firebaseAdmin.auth().getUser(user.uid);
    if ((authUser.multiFactor?.enrolledFactors.length || 0) > 0) {
      throw new ForbiddenException('Use your authenticator code to confirm account deletion.');
    }

    let verifiedReauthTokenHash = '';
    if (body.reauthToken) {
      const reauth = await this.getReauthenticationSession(body.reauthToken, user.uid);
      const decoded = await this.firebaseAdmin.auth().verifyIdToken(reauth.idToken, true);
      if (
        decoded.uid !== user.uid ||
        decoded.email?.toLowerCase() !== user.email.toLowerCase()
      ) {
        throw new UnauthorizedException('Confirm your sign-in again before deleting your account.');
      }
      verifiedReauthTokenHash = createHash('sha256')
        .update(body.reauthToken)
        .digest('hex');
    }

    await this.enforceAuthRateLimit(
      user.email,
      this.getClientIp(request) || 'unknown',
      5,
    );

    const now = Date.now();
    const code = String(randomInt(100000, 1000000));
    const existingChallengeToken = request.cookies?.[ACCOUNT_DELETION_CHALLENGE_COOKIE_NAME];
    const generatedChallengeToken =
      typeof existingChallengeToken === 'string' && existingChallengeToken.length >= 32
        ? existingChallengeToken
        : randomBytes(32).toString('base64url');
    const generatedChallengeTokenHash = createHash('sha256')
      .update(generatedChallengeToken)
      .digest('hex');
    const db = this.firebaseAdmin.db();
    const challengeRef = db.collection('auth_account_deletion_challenges').doc(user.uid);
    const sendLimitRef = db.collection('auth_account_deletion_send_limits').doc(user.uid);

    const sendResult = await db.runTransaction(async transaction => {
      const challengeSnapshot = await transaction.get(challengeRef);
      const limitSnapshot = await transaction.get(sendLimitRef);
      const currentChallenge = challengeSnapshot.data() as {
        challengeTokenHash?: string;
        emailHash?: string;
        passwordVerifiedAt?: number;
        proofExpiresAt?: Timestamp;
      } | undefined;
      const passwordVerifiedAt = Number(currentChallenge?.passwordVerifiedAt);
      const hasActiveProof =
        typeof existingChallengeToken === 'string' &&
        existingChallengeToken.length >= 32 &&
        currentChallenge?.challengeTokenHash === generatedChallengeTokenHash &&
        currentChallenge.emailHash === hashForAudit(user.email) &&
        Number.isFinite(passwordVerifiedAt) &&
        now - passwordVerifiedAt <= ACCOUNT_DELETION_PROOF_TTL_MS &&
        this.timestampToMillis(currentChallenge.proofExpiresAt) > now;
      if (!hasActiveProof && !verifiedReauthTokenHash) {
        throw new UnauthorizedException('Confirm your password again before requesting a code.');
      }
      const proofExpiresAt = hasActiveProof
        ? currentChallenge?.proofExpiresAt
        : Timestamp.fromMillis(now + ACCOUNT_DELETION_PROOF_TTL_MS);
      const verifiedAt = hasActiveProof
        ? currentChallenge?.passwordVerifiedAt
        : now;
      const limit = limitSnapshot.data() as { sentAtMs?: number[] } | undefined;
      const recentSends = (Array.isArray(limit?.sentAtMs) ? limit.sentAtMs : [])
        .filter(sentAt => Number.isFinite(sentAt) && sentAt > now - 24 * 60 * 60_000)
        .sort((left, right) => left - right);
      if (recentSends.length >= ACCOUNT_DELETION_MAX_EMAILS_PER_DAY) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((recentSends[0] + 24 * 60 * 60_000 - now) / 1000),
        );
        throw new HttpException(
          {
            statusCode: 429,
            message: 'Daily account-deletion code limit reached. Please try again later.',
            retryAfterSeconds,
            resendsRemaining: 0,
          },
          429,
        );
      }

      const requiredCooldownMs = ACCOUNT_DELETION_SEND_COOLDOWNS_MS[recentSends.length];
      const retryAfterMs = recentSends.length
        ? recentSends[recentSends.length - 1] + requiredCooldownMs - now
        : 0;
      if (retryAfterMs > 0) {
        throw new HttpException(
          {
            statusCode: 429,
            message: 'Please wait before requesting another account-deletion code.',
            retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
            resendsRemaining: Math.max(0, 3 - Math.max(0, recentSends.length - 1)),
          },
          429,
        );
      }

      transaction.set(challengeRef, {
        uid: user.uid,
        codeHash: this.trustedDeviceCodeHash(user.uid, code),
        challengeTokenHash: generatedChallengeTokenHash,
        passwordVerifiedAt: verifiedAt,
        emailHash: hashForAudit(user.email),
        proofExpiresAt,
        attempts: 0,
        expiresAt: Timestamp.fromMillis(now + ACCOUNT_DELETION_CODE_TTL_MS),
        createdAt: FieldValue.serverTimestamp(),
      });
      const updatedSends = [...recentSends, now];
      transaction.set(sendLimitRef, {
        sentAtMs: updatedSends,
        expiresAt: Timestamp.fromMillis(now + 24 * 60 * 60_000),
      });
      return {
        cooldownSeconds:
          ACCOUNT_DELETION_SEND_COOLDOWNS_MS[updatedSends.length] === undefined
            ? 0
            : ACCOUNT_DELETION_SEND_COOLDOWNS_MS[updatedSends.length] / 1000,
        resendsRemaining: Math.max(0, 3 - Math.max(0, updatedSends.length - 1)),
      };
    });

    await this.resendService.sendEmailVerification({
      email: user.email,
      userName: authUser.displayName || '',
      code,
      expiresIn: '10 minutes',
      appName: 'Chefu Technologies account deletion',
    });
    response.cookie(ACCOUNT_DELETION_CHALLENGE_COOKIE_NAME, generatedChallengeToken, {
      ...this.getCookieOptions(),
      maxAge: ACCOUNT_DELETION_PROOF_TTL_MS,
    });
    return { sent: true, expiresInSeconds: ACCOUNT_DELETION_CODE_TTL_MS / 1000, ...sendResult };
  }

  @Delete('account')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async deleteSharedAccount(
    @Req() request: Request & { user?: AuthenticatedUser; cookies?: Record<string, string> },
    @Res({ passthrough: true }) response: Response,
    @Body()
    body: {
      reauthToken?: string;
      emailCode?: string;
      acknowledged?: boolean;
    },
  ) {
    const user = request.user;
    if (!user?.uid || !user.email) throw new UnauthorizedException('Authentication required.');
    if (body.acknowledged !== true) {
      throw new BadRequestException('Acknowledge the account deletion consequences first.');
    }

    const authUser = await this.firebaseAdmin.auth().getUser(user.uid);
    const hasMfa = (authUser.multiFactor?.enrolledFactors.length || 0) > 0;
    if (hasMfa) {
      const reauth = await this.getReauthenticationSession(body.reauthToken, user.uid);
      const decoded = await this.firebaseAdmin.auth().verifyIdToken(reauth.idToken, true);
      if (
        decoded.uid !== user.uid ||
        decoded.email?.toLowerCase() !== user.email.toLowerCase()
      ) {
        throw new UnauthorizedException('Confirm your sign-in again before deleting your account.');
      }
      if (decoded.firebase?.sign_in_second_factor !== 'totp') {
        throw new UnauthorizedException('Complete authenticator verification before deleting your account.');
      }
    } else {
      const code = String(body.emailCode || '').trim();
      if (!/^\d{6}$/.test(code)) {
        throw new BadRequestException('Enter the 6-digit email code to delete your account.');
      }
      const challengeRef = this.firebaseAdmin.db()
        .collection('auth_account_deletion_challenges')
        .doc(user.uid);
      const challengeToken = request.cookies?.[ACCOUNT_DELETION_CHALLENGE_COOKIE_NAME];
      if (typeof challengeToken !== 'string' || challengeToken.length < 32) {
        throw new UnauthorizedException('Request a new account-deletion code and try again.');
      }
      const challengeTokenHash = createHash('sha256').update(challengeToken).digest('hex');
      const suppliedCodeHash = this.trustedDeviceCodeHash(user.uid, code);
      const accepted = await this.firebaseAdmin.db().runTransaction(async transaction => {
        const snapshot = await transaction.get(challengeRef);
        const challenge = snapshot.data() as {
          uid?: string;
          codeHash?: string;
          challengeTokenHash?: string;
          emailHash?: string;
          passwordVerifiedAt?: number;
          proofExpiresAt?: Timestamp;
          attempts?: number;
          expiresAt?: Timestamp;
        } | undefined;
        if (
          !snapshot.exists ||
          challenge?.uid !== user.uid ||
          challenge.challengeTokenHash !== challengeTokenHash ||
          challenge.emailHash !== hashForAudit(user.email) ||
          !Number.isFinite(challenge.passwordVerifiedAt) ||
          Date.now() - Number(challenge.passwordVerifiedAt) > ACCOUNT_DELETION_PROOF_TTL_MS ||
          this.timestampToMillis(challenge.proofExpiresAt) <= Date.now() ||
          this.timestampToMillis(challenge.expiresAt) <= Date.now() ||
          Number(challenge.attempts || 0) >= TRUSTED_DEVICE_CODE_MAX_ATTEMPTS
        ) {
          throw new BadRequestException('This code expired. Request a new one.');
        }
        const expected = Buffer.from(challenge.codeHash || '');
        const supplied = Buffer.from(suppliedCodeHash);
        const matches =
          expected.length === supplied.length && timingSafeEqual(expected, supplied);
        if (!matches) {
          transaction.update(challengeRef, {
            attempts: FieldValue.increment(1),
            updatedAt: FieldValue.serverTimestamp(),
          });
          return false;
        }
        transaction.delete(challengeRef);
        return true;
      });
      if (!accepted) throw new UnauthorizedException('The email code is incorrect.');
    }

    const db = this.firebaseAdmin.db();
    await this.firebaseAdmin.auth().revokeRefreshTokens(user.uid);
    await this.securityEvents.publishSubjectRevocation({
      actor: user.uid,
      email: user.email,
      reason: 'account_deletion',
      uid: user.uid,
    });
    await this.firebaseAdmin.auth().deleteUser(user.uid);

    try {
      await Promise.all([
        this.clearAccountDeletionDocuments(user.uid),
        db.collection('users').doc(user.email.toLowerCase()).set(
          {
            accountStatus: 'deleted',
            accountDeletedAt: FieldValue.serverTimestamp(),
            roles: [],
            uid: FieldValue.delete(),
            email: FieldValue.delete(),
            fullname: FieldValue.delete(),
            firstName: FieldValue.delete(),
            lastName: FieldValue.delete(),
            phone: FieldValue.delete(),
            website: FieldValue.delete(),
            location: FieldValue.delete(),
            profilePicture: FieldValue.delete(),
            avatarUrl: FieldValue.delete(),
            profilePictureSource: FieldValue.delete(),
            profilePictureUpdatedAt: FieldValue.delete(),
            bio: FieldValue.delete(),
            country: FieldValue.delete(),
            countryCode: FieldValue.delete(),
            countryName: FieldValue.delete(),
            addressStreet: FieldValue.delete(),
            addressCity: FieldValue.delete(),
            addressPostalCode: FieldValue.delete(),
            storeName: FieldValue.delete(),
            storeDescription: FieldValue.delete(),
            detectedCountryCode: FieldValue.delete(),
            detectedCountrySource: FieldValue.delete(),
            detectedCountryUpdatedAt: FieldValue.delete(),
            lastLoginAt: FieldValue.delete(),
            language: FieldValue.delete(),
            learningGoal: FieldValue.delete(),
            skillLevel: FieldValue.delete(),
            learningInterests: FieldValue.delete(),
            weeklyLearningGoal: FieldValue.delete(),
            lessonStyle: FieldValue.delete(),
            defaultCourseDifficulty: FieldValue.delete(),
            preferredContentFormat: FieldValue.delete(),
            aiTutorSuggestions: FieldValue.delete(),
            privacy: FieldValue.delete(),
            onboardingComplete: FieldValue.delete(),
            appGuideComplete: FieldValue.delete(),
            emailPreferences: FieldValue.delete(),
            apps: FieldValue.delete(),
            mfaBackupCodes: FieldValue.delete(),
            securityEmailsEnabled: FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        ),
      ]);
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'account_deletion_cleanup_failed',
          uidHash: hashForAudit(user.uid),
          emailHash: hashForAudit(user.email),
          reason: error instanceof Error ? error.message : 'unknown',
        }),
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException(
        'Your shared sign-in was deleted, but some account security data could not be cleared. Contact support.',
      );
    }

    for (const options of this.getClearCookieOptionsList()) {
      response.clearCookie(SESSION_COOKIE_NAME, options);
      response.clearCookie(SESSION_META_COOKIE_NAME, options);
      response.clearCookie(TRUSTED_DEVICE_COOKIE_NAME, options);
      response.clearCookie(TRUSTED_DEVICE_CHALLENGE_COOKIE_NAME, options);
      response.clearCookie(ACCOUNT_DELETION_CHALLENGE_COOKIE_NAME, options);
    }
    this.logger.warn(
      JSON.stringify({
        event: 'shared_account_deleted',
        uidHash: hashForAudit(user.uid),
        emailHash: hashForAudit(user.email),
      }),
    );
    return { deleted: true };
  }

  private async clearAccountDeletionDocuments(uid: string) {
    const db = this.firebaseAdmin.db();
    const [
      trustedDevices,
      passkeys,
      reauthenticationSessions,
    ] = await Promise.all([
      db.collection('auth_trusted_devices').where('uid', '==', uid).get(),
      db.collection('passkey_credentials').where('uid', '==', uid).get(),
      db.collection('auth_reauthentication_sessions').where('uid', '==', uid).get(),
    ]);
    const documents = [
      ...trustedDevices.docs,
      ...passkeys.docs,
      ...reauthenticationSessions.docs,
    ];
    for (let offset = 0; offset < documents.length; offset += 400) {
      const batch = db.batch();
      for (const document of documents.slice(offset, offset + 400)) {
        batch.delete(document.ref);
      }
      await batch.commit();
    }
    await Promise.all([
      db.collection('auth_account_deletion_challenges').doc(uid).delete(),
      db.collection('auth_account_deletion_send_limits').doc(uid).delete(),
      db.collection('auth_trusted_device_challenges').doc(uid).delete(),
      db.collection('auth_trusted_device_send_limits').doc(uid).delete(),
    ]);
  }

  @Post('trusted-devices/email-challenge')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async sendTrustedDeviceVerificationCode(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = request.user;
    if (!user?.uid || !user.email) throw new UnauthorizedException('Authentication required.');
    const authUser = await this.firebaseAdmin.auth().getUser(user.uid);
    if (!authUser.emailVerified) {
      throw new ForbiddenException('Verify your email before trusting a device.');
    }
    if ((authUser.multiFactor?.enrolledFactors.length || 0) > 0) {
      throw new ForbiddenException('Use your authenticator app to trust a device.');
    }
    await this.enforceAuthRateLimit(
      user.email,
      this.getClientIp(request) || 'unknown',
      3,
    );
    const sendResult = await this.issueTrustedDeviceEmailChallenge({
      uid: user.uid,
      email: user.email,
      userName: authUser.displayName || '',
      request,
      response,
    });
    return {
      sent: true,
      expiresInSeconds: TRUSTED_DEVICE_CHALLENGE_TTL_MS / 1000,
      ...sendResult,
    };
  }

  @Post('trusted-devices/email-verify')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async verifyTrustedDeviceEmailCode(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Res({ passthrough: true }) response: Response,
    @Body() body: { code?: string },
  ) {
    const uid = request.user?.uid;
    const code = String(body.code || '').trim();
    const challengeToken = request.cookies?.[TRUSTED_DEVICE_CHALLENGE_COOKIE_NAME];
    if (!uid || typeof challengeToken !== 'string' || challengeToken.length < 32) {
      throw new UnauthorizedException('Request a new trusted-device code and try again.');
    }
    if (!/^\d{6}$/.test(code)) {
      throw new BadRequestException('Enter the 6-digit email code.');
    }
    const challengeRef = this.firebaseAdmin.db()
      .collection('auth_trusted_device_challenges')
      .doc(uid);
    const codeHash = this.trustedDeviceCodeHash(uid, code);
    const challengeTokenHash = createHash('sha256')
      .update(challengeToken)
      .digest('hex');
    const accepted = await this.firebaseAdmin.db().runTransaction(async transaction => {
      const snapshot = await transaction.get(challengeRef);
      const challenge = snapshot.data() as {
        uid?: string;
        challengeTokenHash?: string;
        codeHash?: string;
        attempts?: number;
        expiresAt?: Timestamp;
      } | undefined;
      if (
        !snapshot.exists ||
        challenge?.uid !== uid ||
        challenge.challengeTokenHash !== challengeTokenHash ||
        this.timestampToMillis(challenge.expiresAt) <= Date.now() ||
        Number(challenge.attempts || 0) >= TRUSTED_DEVICE_CODE_MAX_ATTEMPTS
      ) {
        throw new BadRequestException('This code expired. Request a new one.');
      }
      const expected = Buffer.from(challenge.codeHash || '');
      const supplied = Buffer.from(codeHash);
      const matches =
        expected.length === supplied.length && timingSafeEqual(expected, supplied);
      if (!matches) {
        transaction.update(challengeRef, {
          attempts: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return false;
      }
      transaction.delete(challengeRef);
      return true;
    });
    if (!accepted) {
      throw new UnauthorizedException('The email code is incorrect.');
    }

    const authUser = await this.firebaseAdmin.auth().getUser(uid);
    if (!authUser.emailVerified) {
      throw new ForbiddenException('Verify your email before trusting a device.');
    }
    if ((authUser.multiFactor?.enrolledFactors.length || 0) > 0) {
      throw new ForbiddenException('Use your authenticator app to trust a device.');
    }
    await this.rememberTrustedAuthDevice({
      uid,
      request,
      response,
      source: 'explicit_choice',
    });
    for (const options of this.getClearCookieOptionsList()) {
      response.clearCookie(TRUSTED_DEVICE_CHALLENGE_COOKIE_NAME, options);
    }
    return { trusted: true };
  }

  @Post('trusted-devices/email-resend')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async resendTrustedDeviceVerificationCode(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Res({ passthrough: true }) response: Response,
  ) {
    const user = request.user;
    const challengeToken = request.cookies?.[TRUSTED_DEVICE_CHALLENGE_COOKIE_NAME];
    if (!user?.uid || !user.email || typeof challengeToken !== 'string') {
      throw new UnauthorizedException('Request a trusted-device code first.');
    }
    await this.enforceAuthRateLimit(
      user.email,
      this.getClientIp(request) || 'unknown',
      3,
    );
    const authUser = await this.firebaseAdmin.auth().getUser(user.uid);
    if ((authUser.multiFactor?.enrolledFactors.length || 0) > 0) {
      throw new ForbiddenException('Use your authenticator app to trust a device.');
    }
    const sendResult = await this.issueTrustedDeviceEmailChallenge({
      uid: user.uid,
      email: user.email,
      userName: authUser.displayName || '',
      request,
      response,
    });
    return {
      sent: true,
      expiresInSeconds: TRUSTED_DEVICE_CHALLENGE_TTL_MS / 1000,
      ...sendResult,
    };
  }

  @Post('security/reauthenticate')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async reauthenticateAccount(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Body()
    body: {
      password?: string;
      mfaPendingCredential?: string;
      mfaEnrollmentId?: string;
      verificationCode?: string;
    },
  ) {
    const user = request.user;
    if (!user?.uid || !user.email) {
      throw new UnauthorizedException('Authentication required.');
    }

    await this.enforceAuthRateLimit(user.email, this.getClientIp(request) || 'unknown', 3);
    let idToken = '';
    if (body.mfaPendingCredential) {
      const enrollmentId = String(body.mfaEnrollmentId || '');
      const verificationCode = String(body.verificationCode || '').trim();
      if (!enrollmentId || !/^\d{6}$/.test(verificationCode)) {
        throw new BadRequestException('Enter the 6-digit authenticator code.');
      }
      const response = await fetch(
        `https://identitytoolkit.googleapis.com/v2/accounts/mfaSignIn:finalize?key=${encodeURIComponent(this.getFirebaseWebApiKey())}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mfaPendingCredential: body.mfaPendingCredential,
            mfaEnrollmentId: enrollmentId,
            totpVerificationInfo: { verificationCode },
          }),
        },
      );
      const result = (await response.json().catch(() => ({}))) as {
        idToken?: string;
      };
      idToken = result.idToken || '';
      if (!response.ok || !idToken) {
        throw new UnauthorizedException('The authenticator code is incorrect or expired.');
      }
    } else {
      const password = String(body.password || '');
      if (!password) throw new BadRequestException('Password is required.');
      const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(this.getFirebaseWebApiKey())}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: user.email,
            password,
            returnSecureToken: true,
          }),
        },
      );
      const result = (await response.json().catch(() => ({}))) as {
        idToken?: string;
        mfaPendingCredential?: string;
        mfaInfo?: Array<{
          mfaEnrollmentId?: string;
          displayName?: string;
          totpInfo?: Record<string, unknown>;
        }>;
      };
      if (!response.ok) {
        if (result.mfaPendingCredential) {
          return {
            mfaRequired: true,
            mfaPendingCredential: result.mfaPendingCredential,
            mfaInfo: (result.mfaInfo || [])
              .filter(factor => Boolean(factor.totpInfo))
              .map(factor => ({
                mfaEnrollmentId: factor.mfaEnrollmentId || '',
                displayName: factor.displayName || '',
              })),
          };
        }
        throw new UnauthorizedException('The password is incorrect.');
      }
      idToken = result.idToken || '';
      if (!idToken) {
        throw new BadGatewayException('Authentication service returned an invalid response.');
      }
    }

    const decoded = await this.firebaseAdmin.auth().verifyIdToken(idToken, true);
    if (decoded.uid !== user.uid || decoded.email?.toLowerCase() !== user.email.toLowerCase()) {
      throw new UnauthorizedException('Reauthentication did not match the active account.');
    }

    const reauthToken = randomBytes(32).toString('base64url');
    const expiresAtMs = Date.now() + 5 * 60_000;
    await this.firebaseAdmin.db()
      .collection('auth_reauthentication_sessions')
      .doc(createHash('sha256').update(reauthToken).digest('hex'))
      .create({
        uid: user.uid,
        idToken,
        createdAt: Timestamp.now(),
        expiresAt: Timestamp.fromMillis(expiresAtMs),
      });
    return { mfaRequired: false, reauthToken, expiresInSeconds: 300 };
  }

  @Post('security/totp/setup')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async startTotpEnrollment(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Body() body: { reauthToken?: string },
  ) {
    const user = request.user;
    if (!user?.uid || !user.email) throw new UnauthorizedException('Authentication required.');
    const reauth = await this.getReauthenticationSession(body.reauthToken, user.uid);
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v2/accounts/mfaEnrollment:start?key=${encodeURIComponent(this.getFirebaseWebApiKey())}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: reauth.idToken }),
      },
    );
    const result = (await response.json().catch(() => ({}))) as {
      totpSessionInfo?: {
        sharedSecretKey?: string;
        sessionInfo?: string;
      };
      error?: { message?: string };
    };
    const secret = result.totpSessionInfo?.sharedSecretKey;
    const sessionInfo = result.totpSessionInfo?.sessionInfo;
    if (!response.ok || !secret || !sessionInfo) {
      throw new BadGatewayException(
        result.error?.message || 'Unable to start authenticator setup.',
      );
    }

    const setupId = randomBytes(24).toString('base64url');
    await this.firebaseAdmin.db()
      .collection('auth_totp_setups')
      .doc(createHash('sha256').update(setupId).digest('hex'))
      .create({
        uid: user.uid,
        sessionInfo,
        reauthTokenHash: createHash('sha256').update(body.reauthToken || '').digest('hex'),
        expiresAt: Timestamp.fromMillis(Date.now() + 5 * 60_000),
      });
    const issuer = 'Chefu Technologies';
    const label = `${issuer}:${user.email}`;
    const otpauthUrl =
      `otpauth://totp/${encodeURIComponent(label)}?secret=${encodeURIComponent(secret)}` +
      `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    return { setupId, secret, otpauthUrl, expiresInSeconds: 300 };
  }

  @Post('security/totp/verify')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async verifyTotpEnrollment(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Body() body: { setupId?: string; reauthToken?: string; verificationCode?: string },
  ) {
    const user = request.user;
    if (!user?.uid) throw new UnauthorizedException('Authentication required.');
    const reauth = await this.getReauthenticationSession(body.reauthToken, user.uid);
    const setupId = String(body.setupId || '');
    const verificationCode = String(body.verificationCode || '').trim();
    if (!setupId || !/^\d{6}$/.test(verificationCode)) {
      throw new BadRequestException('Enter the 6-digit authenticator code.');
    }
    const setupRef = this.firebaseAdmin.db().collection('auth_totp_setups')
      .doc(createHash('sha256').update(setupId).digest('hex'));
    const setupSnapshot = await setupRef.get();
    const setup = setupSnapshot.data() as {
      uid?: string;
      sessionInfo?: string;
      reauthTokenHash?: string;
      expiresAt?: Timestamp;
    } | undefined;
    if (
      !setupSnapshot.exists ||
      setup?.uid !== user.uid ||
      (setup.expiresAt?.toMillis() || 0) <= Date.now() ||
      setup.reauthTokenHash !== createHash('sha256').update(body.reauthToken || '').digest('hex')
    ) {
      throw new BadRequestException('Authenticator setup expired. Start again.');
    }
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v2/accounts/mfaEnrollment:finalize?key=${encodeURIComponent(this.getFirebaseWebApiKey())}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken: reauth.idToken,
          displayName: 'My Account TOTP',
          totpVerificationInfo: {
            sessionInfo: setup.sessionInfo,
            verificationCode,
          },
        }),
      },
    );
    const result = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new BadRequestException(
        result.error?.message || 'The authenticator code is incorrect or expired.',
      );
    }
    await setupRef.delete();
    await this.recordAccountSecurityActivity(user.uid, user.email || '', 'mfa_enabled');
    return this.mfaBackupCodes.securitySummary({ email: user.email, uid: user.uid });
  }

  @Post('security/totp/disable')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async disableTotp(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Body() body: { reauthToken?: string; factorUid?: string },
  ) {
    const user = request.user;
    if (!user?.uid || !body.factorUid) {
      throw new BadRequestException('Authenticator factor is required.');
    }
    const reauth = await this.getReauthenticationSession(body.reauthToken, user.uid);
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v2/accounts/mfaEnrollment:withdraw?key=${encodeURIComponent(this.getFirebaseWebApiKey())}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken: reauth.idToken,
          mfaEnrollmentId: body.factorUid,
        }),
      },
    );
    const result = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new BadRequestException(result.error?.message || 'Unable to disable 2FA.');
    }
    await this.revokeCredentialSessions(user.uid, user.email, 'mfa_disabled');
    await this.recordAccountSecurityActivity(user.uid, user.email || '', 'mfa_disabled');
    return this.mfaBackupCodes.securitySummary({ email: user.email, uid: user.uid });
  }

  @Patch('security/password')
  @UseGuards(AuthGuard)
  async changePassword(
    @Req() request: Request & { user?: AuthenticatedUser },
    @Body() body: { reauthToken?: string; newPassword?: string },
  ) {
    const user = request.user;
    const newPassword = String(body.newPassword || '');
    if (!user?.uid || newPassword.length < 8 || newPassword.length > 128) {
      throw new BadRequestException('Password must be between 8 and 128 characters.');
    }
    await this.getReauthenticationSession(body.reauthToken, user.uid);
    await this.firebaseAdmin.auth().updateUser(user.uid, { password: newPassword });
    await this.revokeCredentialSessions(user.uid, user.email, 'password_changed');
    await this.recordAccountSecurityActivity(user.uid, user.email || '', 'password_changed');
    return { ok: true };
  }

  @Post('security/email-verification')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async sendAccountEmailVerification(
    @Req() request: Request & { user?: AuthenticatedUser },
  ) {
    const user = request.user;
    if (!user?.uid || !user.email) throw new UnauthorizedException('Authentication required.');
    const authUser = await this.firebaseAdmin.auth().getUser(user.uid);
    if (authUser.emailVerified) return { sent: false, verified: true };
    const verificationUrl = await this.firebaseAdmin.auth()
      .generateEmailVerificationLink(user.email);
    await this.resendService.sendAccountEmailVerification({
      email: user.email,
      userName: authUser.displayName || user.email.split('@')[0],
      verificationUrl,
    });
    await this.recordAccountSecurityActivity(user.uid, user.email, 'verification_email_sent');
    return { sent: true, verified: false };
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

}
