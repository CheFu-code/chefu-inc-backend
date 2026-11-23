import { ForbiddenException, Headers, HttpException, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { Request, Response } from 'express';
import { auditRequestContext, hashForAudit } from '../../common/security-audit';
import { CHEFU_APP_HEADER } from '../apps/app-registry';
import { FirebaseDecodedToken } from './auth-controller.types';
import { authStage } from './auth-performance';
import { decodeJwtPayload } from './auth.controller.base';
import { phoneContact } from './phone-contact';
import { ADMIN_ROLE } from './roles';
import { assessSessionRisk } from './session-risk';
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS, SESSION_META_COOKIE_NAME } from './session.constants';
import { AuthAccountRoutes } from './auth-account.routes';

export abstract class AuthSessionCreationRoutes extends AuthAccountRoutes {
    @Post('session')
    async createSession(
        @Headers('authorization') authorization: string | undefined,
        @Headers(CHEFU_APP_HEADER) chefuApp: string | undefined,
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

        const sessionAppId = await this.resolveSessionAppId(chefuApp);
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
            }),
        );

        let decodedToken: FirebaseDecodedToken;
        let sessionCookie: string;

        try {
            decodedToken = await authStage(response, 'verify_token', () =>
                this.firebaseAdmin.auth().verifyIdToken(idToken, true),
            );
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
                }),
                error instanceof Error ? error.stack : undefined,
            );
            throw new UnauthorizedException('Unable to verify your session. Please sign in again.');
        }

        if (decodedToken.email_verified !== true) {
            throw new ForbiddenException('Please verify your email address before continuing.');
        }

        if (sessionAppId === 'admin') {
            const profileForAccess = await this.getUserProfile(decodedToken.email);
            if (
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
        }

        try {
            const expiresIn = SESSION_MAX_AGE_SECONDS * 1000;
            sessionCookie = await authStage(response, 'session_cookie', () =>
                this.firebaseAdmin.auth().createSessionCookie(idToken, { expiresIn }),
            );
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
                }),
                error instanceof Error ? error.stack : undefined,
            );
            throw new UnauthorizedException('Unable to verify your session. Please sign in again.');
        }

        await authStage(response, 'profile_sync', () =>
            this.ensureUserProfile(decodedToken, sessionAppId, request),
        );
        const signupAlertSuppressed = decodedToken.email
            ? await this.consumeSignupSignInAlertSuppression(decodedToken.email)
            : false;
        const isSignupSession = signupSession || signupAlertSuppressed;
        // Profile is already synchronized. Its read is independent from verifying
        // the existing trusted-device cookie and can overlap the network round trip.
        const [wasTrustedDevice, userProfile] = await Promise.all([
            authStage(response, 'trusted_device', () =>
                this.isTrustedAuthDevice(decodedToken.uid, request),
            ),
            authStage(response, 'profile_read', () =>
                this.getUserProfile(decodedToken.email),
            ),
        ]);
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
            profilePicture: userProfile.profilePicture || undefined,
        });

        await this.preserveActiveAccountSession(request, response, decodedToken.uid);
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

        if (!isSignupSession) {
            const risk = assessSessionRisk({
                trustedDevice: wasTrustedDevice,
                userAgent: request.headers['user-agent'],
                appId: sessionAppId,
            });
            this.logger.log(JSON.stringify({
                event: 'auth_session_risk_assessed',
                uidHash: hashForAudit(decodedToken.uid),
                app: sessionAppId,
                ...risk,
                ...auditRequestContext(request),
            }));
        }

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
            ...phoneContact(userProfile),
        };
    }
}
