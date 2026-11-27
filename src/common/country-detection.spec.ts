import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import express, { type Request } from 'express';
import {
    configureCountryDetection, detectRequestCountry, normalizeDetectedCountryCode,
} from './country-detection';

const cloudflareSecret = 'test-secret-with-more-than-thirty-two-bytes';
const cloudflareSecretHeader = 'x-chefu-country-proxy-secret';

function configuredApp(
    provider?: string,
    addresses = ['192.0.2.0/24', '2001:db8::/32'],
    sharedSecret?: string,
) {
    const app = express();
    app.set('trust proxy', addresses);
    configureCountryDetection(app, provider, sharedSecret);
    return app;
}

function incoming(app: express.Express, peer: string, rawHeaders: string[]): Request {
    const headers: Record<string, string | string[]> = {};
    for (let index = 0; index < rawHeaders.length; index += 2) {
        const name = rawHeaders[index].toLowerCase();
        const value = rawHeaders[index + 1];
        headers[name] = headers[name] === undefined ? value : [String(headers[name]), value];
    }
    return { app, socket: { remoteAddress: peer }, rawHeaders, headers } as unknown as Request;
}

void test('detection defaults off even when a trusted connection includes provider headers', () => {
    const app = configuredApp();
    assert.equal(detectRequestCountry(incoming(app, '192.0.2.7', ['cf-ipcountry', 'ZA'])), null);
    assert.equal(detectRequestCountry(), null);
});

void test('enabled detection requires a known provider and explicit bounded proxy trust', () => {
    for (const provider of ['auto', '*', '__proto__', 'cloudflare,vercel']) {
        assert.throws(() => configuredApp(provider, undefined, cloudflareSecret), /COUNTRY_HEADER_PROVIDER/);
    }
    assert.throws(() => configuredApp('cloudflare'), /COUNTRY_PROXY_SHARED_SECRET/);
    assert.throws(() => configuredApp('cloudflare', undefined, 'too-short'), /COUNTRY_PROXY_SHARED_SECRET/);
    for (const setting of [true, 1, [], ['loopback'], ['0.0.0.0/0'], ['::/0']]) {
        const app = express();
        assert.throws(() => {
            app.set('trust proxy', setting);
            configureCountryDetection(app, 'cloudflare', cloudflareSecret);
        }, /TRUSTED_PROXY_IPS|invalid range/);
    }
});

void test('country codes must be assigned ISO alpha-2 codes, never provider sentinels or arbitrary pairs', () => {
    for (const value of ['ZA', 'za', ' ZA ', 'GB', 'US', 'AX']) {
        assert.equal(normalizeDetectedCountryCode(value), value.trim().toUpperCase());
    }
    for (const value of [undefined, null, 27, ['ZA'], '', 'XX', 'T1', 'ZZ', 'AA', 'UK', 'EU',
        'ZAF', 'ZA,US', 'ZA\r\nUS', 'ZА', ' '.repeat(1000) + 'ZA']) {
        assert.equal(normalizeDetectedCountryCode(value), null);
    }
});

void test('only the actual trusted TCP peer establishes country-header trust', () => {
    const app = configuredApp('cloudflare', undefined, cloudflareSecret);
    const trustedHeaders = ['CF-IPCountry', 'za', cloudflareSecretHeader, cloudflareSecret];
    for (const peer of ['192.0.2.7', '2001:db8::7', '::ffff:192.0.2.7']) {
        assert.deepEqual(detectRequestCountry(incoming(app, peer, trustedHeaders)), {
            code: 'ZA', source: 'cloudflare',
        });
    }
    for (const peer of ['198.51.100.7', '2001:db9::7', '::ffff:198.51.100.7', 'invalid', '']) {
        assert.equal(detectRequestCountry(incoming(app, peer, [
            'cf-ipcountry', 'ZA', 'x-forwarded-for', '192.0.2.7',
            'cf-connecting-ip', '192.0.2.7', 'x-vercel-ip-country', 'ZA',
            cloudflareSecretHeader, cloudflareSecret,
        ])), null);
    }
});

void test('all supported providers work independently with no fallback to other country headers', () => {
    for (const [source, header] of [
        ['cloudflare', 'cf-ipcountry'], ['vercel', 'x-vercel-ip-country'],
        ['cloudfront', 'cloudfront-viewer-country'], ['appengine', 'x-appengine-country'],
        ['proxy', 'x-country-code'],
    ]) {
        const app = configuredApp(
            source,
            undefined,
            source === 'cloudflare' ? cloudflareSecret : undefined,
        );
        const acceptedHeaders = source === 'cloudflare'
            ? [header, 'ZA', cloudflareSecretHeader, cloudflareSecret]
            : [header, 'ZA'];
        assert.deepEqual(detectRequestCountry(incoming(app, '192.0.2.7', acceptedHeaders)), {
            code: 'ZA', source,
        });
        const otherHeader = source === 'cloudflare' ? 'x-country-code' : 'cf-ipcountry';
        for (const raw of [
            source === 'cloudflare'
                ? [otherHeader, 'US', cloudflareSecretHeader, cloudflareSecret]
                : [otherHeader, 'US'],
            source === 'cloudflare'
                ? [header, 'ZZ', otherHeader, 'US', cloudflareSecretHeader, cloudflareSecret]
                : [header, 'ZZ', otherHeader, 'US'],
        ]) {
            assert.equal(detectRequestCountry(incoming(app, '192.0.2.7', raw)), null);
        }
    }
});

void test('duplicate headers, arrays and combined country values are rejected', () => {
    const app = configuredApp('cloudflare', undefined, cloudflareSecret);
    for (const raw of [
        ['cf-ipcountry', 'ZA', 'CF-IPCountry', 'US', cloudflareSecretHeader, cloudflareSecret],
        ['cf-ipcountry', 'ZA', 'cf-ipcountry', 'ZA', cloudflareSecretHeader, cloudflareSecret],
        ['cf-ipcountry', 'ZA, US', cloudflareSecretHeader, cloudflareSecret],
        ['cf-ipcountry', '', cloudflareSecretHeader, cloudflareSecret],
        ['cf-ipcountry', 'ZA'],
        ['cf-ipcountry', 'ZA', cloudflareSecretHeader, 'wrong-secret-value-long-enough-to-pass-size'],
        [
            'cf-ipcountry', 'ZA',
            cloudflareSecretHeader, cloudflareSecret,
            'X-Chefu-Country-Proxy-Secret', cloudflareSecret,
        ],
    ]) {
        assert.equal(detectRequestCountry(incoming(app, '192.0.2.7', raw)), null);
    }
    const arrayHeader = incoming(app, '192.0.2.7', [
        'cf-ipcountry', 'ZA', cloudflareSecretHeader, cloudflareSecret,
    ]);
    arrayHeader.headers['cf-ipcountry'] = ['ZA'];
    assert.equal(detectRequestCountry(arrayHeader), null);
});

void test('real HTTP requests reject spoofed forwarding and duplicate headers', async t => {
    const app = configuredApp('cloudflare', ['127.0.0.1'], cloudflareSecret);
    app.get('/country', (req, res) => { res.json(detectRequestCountry(req)); });
    const server = app.listen(0, '127.0.0.1');
    t.after(() => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    }));
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const send = (headers: string[]) => new Promise<unknown>((resolve, reject) => {
        const request = httpRequest({
            hostname: '127.0.0.1', port: address.port, path: '/country',
            headers: ['Host', '127.0.0.1', 'Connection', 'close', ...headers],
        }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => { body += chunk; });
            response.on('error', reject);
            response.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        });
        request.on('error', reject);
        request.end();
    });
    assert.deepEqual(await send([
        'cf-ipcountry', 'ZA', cloudflareSecretHeader, cloudflareSecret,
    ]), { code: 'ZA', source: 'cloudflare' });
    assert.equal(await send([
        'cf-ipcountry', 'ZA', 'CF-IPCountry', 'US',
        cloudflareSecretHeader, cloudflareSecret,
    ]), null);
    assert.equal(await send([
        'cf-ipcountry', 'XX', 'x-country-code', 'ZA',
        cloudflareSecretHeader, cloudflareSecret,
    ]), null);
    assert.equal(await send(['cf-ipcountry', 'ZA']), null);
    // The same headers over a real connection outside the allowlist are rejected.
    app.set('trust proxy', ['192.0.2.7']);
    configureCountryDetection(app, 'cloudflare', cloudflareSecret);
    assert.equal(await send(['cf-ipcountry', 'ZA', 'x-forwarded-for', '192.0.2.7']), null);
});
