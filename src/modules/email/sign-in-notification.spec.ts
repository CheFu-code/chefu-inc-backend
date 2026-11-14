import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHEFU_APPS } from '../apps/app-registry';
import { ResendService } from './resend.service';

test('sign-in alerts use registered app names in the sender, subject and template', async t => {
    const requests: Record<string, any>[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        return new Response('{}', { status: 200 });
    });
    const service = new ResendService();
    Object.assign(service, {
        getApiKey: () => 'test-only-key',
        logger: { log() {} },
        securityFromByApp: {},
    });

    const cases = [
        ...CHEFU_APPS.map(app => ({ appId: app.id, name: app.name })),
        { appId: ' SHOPyethu ', name: 'ShopYethu' },
        { appId: undefined, name: 'Chefu Technologies' },
        { appId: 'unknown-app', name: 'Chefu Technologies' },
    ];
    for (const { appId, name } of cases) {
        await service.sendSignInNotification({
            email: 'buyer@example.test', provider: 'password',
            timestamp: new Date('2026-11-14T10:00:00Z'), appId,
        });
        const payload = requests.at(-1)!;
        assert.equal(payload.from, `${name} <security@chefu.co.za>`, appId);
        assert.equal(payload.subject, `Security alert: new sign-in to ${name}`, appId);
        assert.equal(payload.template.id, 'sign-in-alert');
        assert.equal(payload.template.variables.APP_NAME, name, appId);
        assert.equal(payload.template.variables.appName, name, appId);
    }

    Object.assign(service, {
        securityFromByApp: { shopyethu: 'ShopYethu Security <security@chefu.co.za>' },
    });
    await service.sendSignInNotification({
        email: 'buyer@example.test', provider: 'passkey',
        timestamp: new Date(), appId: 'shopyethu',
    });
    assert.equal(requests.at(-1)!.from, 'ShopYethu Security <security@chefu.co.za>');
    assert.equal(requests.at(-1)!.template.variables.APP_NAME, 'ShopYethu');
});
