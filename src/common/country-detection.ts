import { timingSafeEqual } from 'node:crypto';
import type { Application, Request } from 'express';
import { isIP } from 'node:net';
import isISO31661Alpha2 from 'validator/lib/isISO31661Alpha2';
import { getTrustedProxyAddresses } from './proxy-trust';

const cloudflareSecretHeader = 'x-chefu-country-proxy-secret';
const providerHeaders = new Map([
    ['cloudflare', 'cf-ipcountry'],
    ['vercel', 'x-vercel-ip-country'],
    ['cloudfront', 'cloudfront-viewer-country'],
    ['appengine', 'x-appengine-country'],
    ['proxy', 'x-country-code'],
]);

type CountryPolicy = {
    source: string;
    header: string;
    trust: (address: string, hop: number) => boolean;
    cloudflareSecret?: Buffer;
};

// Configure once at startup. No environment parsing, network requests or
// database work on the request path. Missing configuration disables detection.
const policies = new WeakMap<Application, CountryPolicy>();

export function configureCountryDetection(
    app: Application,
    provider?: string,
    cloudflareProxySecret?: string,
) {
    policies.delete(app);
    const source = provider?.trim().toLowerCase();
    if (!source) return;
    const header = providerHeaders.get(source);
    if (!header) {
        throw new Error('COUNTRY_HEADER_PROVIDER must be cloudflare, vercel, cloudfront, appengine or proxy.');
    }
    const cloudflareSecret = source === 'cloudflare'
        ? Buffer.from(cloudflareProxySecret?.trim() || '', 'utf8')
        : undefined;
    if (source === 'cloudflare' &&
        (!cloudflareSecret || cloudflareSecret.length < 32 || cloudflareSecret.length > 256)) {
        throw new Error(
            'COUNTRY_PROXY_SHARED_SECRET must be 32 to 256 bytes when COUNTRY_HEADER_PROVIDER=cloudflare.',
        );
    }
    const addresses: unknown = app.get('trust proxy');
    if (!Array.isArray(addresses) || !addresses.length ||
        addresses.some(address => typeof address !== 'string')) {
        throw new Error('Country detection requires explicit TRUSTED_PROXY_IPS.');
    }
    const trusted = getTrustedProxyAddresses(addresses.join(','));
    if (trusted.some(address => /\/0$/.test(address))) {
        throw new Error('Country detection cannot trust an entire Internet address family. Narrow TRUSTED_PROXY_IPS.');
    }
    const trust: unknown = app.get('trust proxy fn');
    if (typeof trust !== 'function') {
        throw new Error('Configure Express proxy trust before country detection.');
    }
    policies.set(app, {
        source,
        header,
        trust: trust as CountryPolicy['trust'],
        cloudflareSecret,
    });
}

export function normalizeDetectedCountryCode(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 8) return null;
    const code = value.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(code) && isISO31661Alpha2(code) ? code : null;
}

export function detectRequestCountry(request?: Request) {
    const policy = request?.app && policies.get(request.app);
    if (!request || !policy) return null;
    // Check the actual TCP peer. Forwarded IPs and provider-looking headers
    // cannot establish trust. The configured proxy must overwrite this header.
    const peer = request.socket?.remoteAddress;
    if (!peer || !isIP(peer) || !policy.trust(peer, 0)) return null;
    if (policy.cloudflareSecret && !hasCloudflareProxySecret(request, policy.cloudflareSecret)) {
        return null;
    }
    let occurrences = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
        if (request.rawHeaders[index].toLowerCase() === policy.header) occurrences++;
    }
    if (occurrences !== 1) return null;
    const code = normalizeDetectedCountryCode(request.headers[policy.header]);
    return code ? { code, source: policy.source } : null;
}

function hasCloudflareProxySecret(request: Request, expected: Buffer) {
    let occurrences = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
        if (request.rawHeaders[index].toLowerCase() === cloudflareSecretHeader) occurrences++;
    }
    if (occurrences !== 1) return false;

    const value = request.headers[cloudflareSecretHeader];
    if (typeof value !== 'string') return false;
    const actual = Buffer.from(value, 'utf8');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
