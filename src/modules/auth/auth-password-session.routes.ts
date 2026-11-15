import { BadGatewayException, BadRequestException, Body, Headers, HttpCode, HttpException, InternalServerErrorException, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { Request, Response } from 'express';
import isEmail from 'validator/lib/isEmail';
import { hashForAudit } from '../../common/security-audit';
import { CHEFU_APP_HEADER } from '../apps/app-registry';
import { authStage } from './auth-performance';
import { findPasswordBreachCount, getPasswordBreachRange } from './password-breach';
import { AuthSessionCreationRoutes } from './auth-session-creation.routes';

export abstract class AuthPasswordSessionRoutes extends AuthSessionCreationRoutes {
    @Post('login')
    @HttpCode(200)
    async login(
        @Body() body: { email?: string; password?: string },
        @Req() request: Request,
    ) {
        return this.authenticatePassword(body, request, true);
    }

    private async authenticatePassword(
        body: { email?: string; password?: string },
        request: Request,
        includeCustomToken: boolean,
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
                localId?: string;
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
                if (errorBody.localId) {
                    void this.inspectPasswordForBreach(email, password);
                }
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
                if (payload?.localId || payload?.local_id) {
                    void this.inspectPasswordForBreach(email, password);
                }
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
        const customToken = includeCustomToken
            ? await this.firebaseAdmin.auth().createCustomToken(uid, {
                chefu_auth_provider: 'password',
            })
            : undefined;
        void this.inspectPasswordForBreach(payload.email || email, password);

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

    private async inspectPasswordForBreach(email: string, password: string) {
        try {
            const { prefix, suffix } = getPasswordBreachRange(password);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5_000);
            let response: globalThis.Response;
            try {
                response = await fetch(
                    `https://api.pwnedpasswords.com/range/${prefix}`,
                    {
                        headers: {
                            'Add-Padding': 'true',
                            'User-Agent': 'Chefu-Account-Password-Breach-Check',
                        },
                        signal: controller.signal,
                    },
                );
            } finally {
                clearTimeout(timeout);
            }

            if (!response.ok) {
                throw new Error(`Password breach lookup failed with status ${response.status}.`);
            }
            const rangeResponse = await response.text();
            const breachCount = findPasswordBreachCount(rangeResponse, suffix);
            if (breachCount === 0) return;

            const alertLimit = await this.runtimeLimits.reserve({
                collection: 'password_breach_alert_limits',
                key: email.toLowerCase(),
                limit: 1,
                windowMs: 24 * 60 * 60 * 1000,
            });
            if (alertLimit.limited) return;

            await this.resendService.sendBreachedPasswordAlert({
                email,
                breachCount,
                detectedAt: new Date(),
            });
            this.logger.warn(
                JSON.stringify({
                    event: 'password_breach_detected',
                    emailHash: hashForAudit(email),
                    notificationSent: true,
                }),
            );
        } catch (error) {
            this.logger.error(
                JSON.stringify({
                    event: 'password_breach_check_failed',
                    emailHash: hashForAudit(email),
                    errorName: error instanceof Error ? error.name : 'unknown',
                }),
            );
        }
    }

    @Post('session/password')
    @HttpCode(200)
    async createPasswordSession(
        @Body() body: { email?: string; password?: string; trustDevice?: boolean },
        @Headers(CHEFU_APP_HEADER) chefuApp: string | undefined,
        @Req() request: Request,
        @Res({ passthrough: true }) response: Response,
    ) {
        // Browser sessions consume the ID token directly. Keep custom-token minting
        // only for legacy /login clients that actually consume that response field.
        const authResult = await authStage(response, 'password', () =>
            this.authenticatePassword(body, request, false),
        );
        return this.createSession(
            `Bearer ${authResult.idToken}`,
            chefuApp,
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
            request,
            response,
            body.trustDevice === true,
        );
    }
}
