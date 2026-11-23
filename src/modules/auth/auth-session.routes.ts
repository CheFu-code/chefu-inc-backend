import { Body, Delete, Get, Headers, HttpCode, Post, Query, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { auditRequestContext } from '../../common/security-audit';
import { CHEFU_APP_HEADER } from '../apps/app-registry';
import { FirebaseDecodedToken } from './auth-controller.types';
import { AuthGuard } from './auth.guard';
import { AuthenticatedUser } from './authenticated-user';
import { phoneContact } from './phone-contact';
import { ADMIN_ROLE } from './roles';
import { SESSION_COOKIE_NAME } from './session.constants';
import { AuthPasswordSessionRoutes } from './auth-password-session.routes';

export abstract class AuthSessionRoutes extends AuthPasswordSessionRoutes {
    @Get('session/status')
    async getSessionStatus(
        @Headers(CHEFU_APP_HEADER) chefuApp: string | undefined,
        @Req() request: Request,
        @Res({ passthrough: true }) response: Response,
    ) {
        response.setHeader('Cache-Control', 'private, no-store');
        const cookie = request.cookies?.[SESSION_COOKIE_NAME];
        if (typeof cookie !== 'string' || !cookie) return { authenticated: false };

        let decoded: FirebaseDecodedToken;
        try {
            decoded = await this.firebaseAdmin.auth().verifySessionCookie(cookie, true);
        } catch {
            return { authenticated: false };
        }

        if (!decoded.uid || !decoded.email || decoded.email_verified !== true) {
            return { authenticated: false };
        }
        const appId = await this.resolveSessionAppId(chefuApp);
        const profile = await this.getUserProfile(decoded.email);
        if (appId === 'admin') {
            if (!profile.roles.some(role => role.trim().toLowerCase() === ADMIN_ROLE)) {
                return { authenticated: false };
            }
        }
        return { authenticated: true, ...phoneContact(profile) };
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
        @Query('current') currentLogout: string | undefined,
        @Req() request: Request,
        @Res({ passthrough: true }) response: Response,
    ) {
        const revokeGlobally =
            globalLogout === 'true' || globalLogout === '1' || globalLogout === 'yes';
        const clearCurrentOnly = !revokeGlobally && currentLogout === 'true';
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
            if (clearCurrentOnly) this.clearCurrentSessionCookies(response);
            else this.clearSessionCookies(response);
            this.logger.log(
                JSON.stringify({
                    event: 'auth_session_cleared',
                    global: revokeGlobally,
                    currentOnly: clearCurrentOnly,
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
