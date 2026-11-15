import { accountSessionReader, readAccountSlots, synchronizeAccountSlots } from './account-session-slots';
import { BadRequestException, Body, Delete, Get, HttpCode, Param, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import { shouldRefreshDetectedCountry } from './auth-performance';
import { AuthGuard } from './auth.guard';
import { AuthenticatedUser } from './authenticated-user';
import { phoneContact } from './phone-contact';
import { ACCOUNT_SESSION_SLOT_COUNT, accountSessionSlotCookieName, accountSessionSlotMetaCookieName, SESSION_COOKIE_NAME, SESSION_META_COOKIE_NAME } from './session.constants';
import { AuthControllerBase } from './auth.controller.base';

export abstract class AuthAccountRoutes extends AuthControllerBase {
    @Get('accounts')
    async listAccounts(@Req() request: Request & { user?: AuthenticatedUser }) {
        const auth = this.firebaseAdmin.auth();
        const read = accountSessionReader(auth);
        const pendingCurrent = request.user ? Promise.resolve(request.user) : read(request.cookies?.[SESSION_COOKIE_NAME]);
        const pendingSlots = readAccountSlots(request.cookies, read);
        const current = await pendingCurrent;
        const seen = new Set<string>();
        const candidates: Array<{ uid: string; email: string; slot: number | null; meta?: string; active: boolean }> = [];
        if (current?.uid && current.email) {
            seen.add(current.uid);
            candidates.push({ ...current, slot: null, meta: request.cookies?.[SESSION_META_COOKIE_NAME], active: true });
        }
        for (const saved of await pendingSlots) {
            if (!saved.identity || seen.has(saved.identity.uid)) continue;
            seen.add(saved.identity.uid);
            candidates.push({ ...saved.identity, slot: saved.slot, meta: saved.meta, active: false });
        }
        // Deduplicate verified UIDs before optional legacy display lookups.
        const accounts = await Promise.all(candidates.map(async ({ uid, email, slot, meta: rawMeta, active }) => {
            let details: { fullName?: string; profilePicture?: string } = {};
            const meta = this.sessionSigner.verify(rawMeta);
            if (meta?.uid === uid && meta.email === email) {
                details = { fullName: meta.name, profilePicture: meta.profilePicture };
            } else {
                try {
                    const user = await auth.getUser(uid);
                    details = { fullName: user.displayName, profilePicture: user.photoURL };
                } catch { /* Legacy display lookup failures must not block valid accounts. */ }
            }
            return { slot, email, ...details, active };
        }));
        return { accounts };
    }

    @Post('accounts/switch')
    @HttpCode(200)
    async switchAccount(
        @Body() body: { slot?: number },
        @Req() request: Request,
        @Res({ passthrough: true }) response: Response,
    ) {
        const slot = Number(body.slot);
        if (!Number.isInteger(slot) || slot < 0 || slot >= ACCOUNT_SESSION_SLOT_COUNT) {
            throw new BadRequestException('Invalid account slot.');
        }
        const targetCookie = request.cookies?.[accountSessionSlotCookieName(slot)];
        if (!targetCookie) throw new BadRequestException('Account slot is empty.');
        const targetMeta = request.cookies?.[accountSessionSlotMetaCookieName(slot)];
        const auth = this.firebaseAdmin.auth();
        const target = await auth.verifySessionCookie(targetCookie, true);
        if (!target.uid || !target.email) throw new UnauthorizedException('Invalid saved account.');
        const targetPhone = phoneContact(await this.getUserProfile(target.email, request));
        const read = accountSessionReader(auth, { cookie: targetCookie, identity: { uid: target.uid, email: target.email } });
        const currentCookie = request.cookies?.[SESSION_COOKIE_NAME];
        const [current, slots] = await Promise.all([read(currentCookie), readAccountSlots(request.cookies, read)]);
        if (currentCookie && !current) this.clearCurrentSessionCookies(response);
        synchronizeAccountSlots({
            slots, activeUid: target.uid, preferredSlot: slot, response, options: this.getCookieOptions(),
            previous: current ? { cookie: currentCookie, meta: request.cookies?.[SESSION_META_COOKIE_NAME], identity: current } : undefined,
        });
        response.cookie(SESSION_COOKIE_NAME, targetCookie, this.getCookieOptions());
        if (targetMeta) response.cookie(SESSION_META_COOKIE_NAME, targetMeta, this.getCookieOptions());
        else response.clearCookie(SESSION_META_COOKIE_NAME, this.getCookieOptions());
        return { ok: true, email: target.email, ...targetPhone };
    }

    @Delete('accounts/:slot')
    @UseGuards(AuthGuard)
    @HttpCode(200)
    async removeAccount(
        @Param('slot') rawSlot: string,
        @Res({ passthrough: true }) response: Response,
        @Req() request?: Request,
    ) {
        const slot = Number(rawSlot);
        if (!Number.isInteger(slot) || slot < 0 || slot >= ACCOUNT_SESSION_SLOT_COUNT) {
            throw new BadRequestException('Invalid account slot.');
        }
        const removed = new Set([slot]);
        if (request) {
            const slots = await readAccountSlots(request.cookies, accountSessionReader(this.firebaseAdmin.auth()));
            const uid = slots.find(saved => saved.slot === slot)?.identity?.uid;
            if (uid) for (const saved of slots) if (saved.identity?.uid === uid) removed.add(saved.slot);
        }
        for (const savedSlot of removed) {
            response.clearCookie(accountSessionSlotCookieName(savedSlot), this.getCookieOptions());
            response.clearCookie(accountSessionSlotMetaCookieName(savedSlot), this.getCookieOptions());
        }
        return { ok: true };
    }

    @Delete('connected-apps/:appId')
    @UseGuards(AuthGuard)
    @HttpCode(200)
    async revokeConnectedApp(
        @Param('appId') appId: string,
        @Req() request: Request & { user?: AuthenticatedUser },
    ) {
        const resolvedAppId = this.appsService.resolveId(appId);
        if (!resolvedAppId) {
            throw new BadRequestException('Unknown connected app.');
        }
        if (!request.user?.email) {
            throw new UnauthorizedException('Authenticated user missing from request.');
        }

        await this.firebaseAdmin
            .db()
            .collection('users')
            .doc(request.user.email)
            .set(
                {
                    apps: {
                        [resolvedAppId]: {
                            enabled: false,
                            revokedAt: FieldValue.serverTimestamp(),
                        },
                    },
                },
                { merge: true },
            );

        return { ok: true, appId: resolvedAppId };
    }

    @Get('me')
    @UseGuards(AuthGuard)
    async getCurrentUser(
        @Req() request: Request & { user?: AuthenticatedUser },
        @Res({ passthrough: true }) response?: Response,
    ) {
        if (!request.user) {
            throw new UnauthorizedException('Authenticated user missing from request.');
        }

        const startedAt = performance.now();
        const profile = await this.getUserProfile(request.user.email, request);
        const profileReadDuration = performance.now() - startedAt;
        const detected = this.getDetectedCountry(request);
        const needsCountryUpdate = shouldRefreshDetectedCountry(
            detected?.code || null,
            profile.detectedCountryCode,
            profile.detectedCountryUpdatedAt,
        );
        const countrySaved = needsCountryUpdate
            ? await this.recordServerDetectedCountry(request.user.email, request) : false;
        if (countrySaved && detected) {
            profile.detectedCountryCode = detected.code;
            profile.detectedCountrySource = detected.source;
            profile.detectedCountryUpdatedAt = new Date().toISOString();
        }
        if (response && !response.headersSent) {
            response.setHeader('Server-Timing',
                `account_profile;dur=${profileReadDuration.toFixed(1)}, account_sync;dur=${(performance.now() - startedAt - profileReadDuration).toFixed(1)}`);
            response.setHeader('Cache-Control', 'private, no-store');
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

    protected async preserveActiveAccountSession(request: Request, response: Response, newUid: string) {
        const read = accountSessionReader(this.firebaseAdmin.auth());
        const currentCookie = request.cookies?.[SESSION_COOKIE_NAME];
        const [current, slots] = await Promise.all([read(currentCookie), readAccountSlots(request.cookies, read)]);
        synchronizeAccountSlots({
            slots, activeUid: newUid, response, options: this.getCookieOptions(),
            previous: current ? { cookie: currentCookie, meta: request.cookies?.[SESSION_META_COOKIE_NAME], identity: current } : undefined,
        });
    }
}
