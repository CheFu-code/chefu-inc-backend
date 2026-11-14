import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthControllerBase } from './auth.controller.base';
import type { SignInNotificationData } from '../email/resend.types';

void test('sign-in alert email receives the detected country name', async () => {
    const controller: any = Object.create(AuthControllerBase.prototype);
    let sent: SignInNotificationData | undefined;
    Object.assign(controller, {
        logger: { log() {}, error() {} },
        reserveSignInAlert: async () => ({
            reason: 'first_alert',
            shouldSend: true,
            throttleMs: 360000,
        }),
        getDetectedCountry: () => ({ code: 'ZA', source: 'cloudflare' }),
        getClientIp: () => '192.0.2.1',
        resendService: {
            sendSignInNotification: async (data: SignInNotificationData) => {
                sent = data;
            },
        },
    });

    await controller.sendThrottledSignInNotification({
        email: 'alice@example.test',
        uid: 'alice',
        provider: 'password',
        request: { headers: { 'user-agent': 'Test Browser' } },
    });

    assert.equal(sent?.country, 'South Africa');
});
