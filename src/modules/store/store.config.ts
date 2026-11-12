import type { ServiceEnvGroup } from '../../common/env/env';

export function validateStoreEnv(env: NodeJS.ProcessEnv): ServiceEnvGroup {
  const missing: ServiceEnvGroup['missing'] = [];
  const key = env.PAYSTACK_SECRET_KEY;
  if (env.STORE_CHECKOUT_ENABLED === 'true' || key) {
    if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(key ?? '')) missing.push({ name: 'PAYSTACK_SECRET_KEY', description: 'A valid server-side Paystack secret is required' });
    if (!['test', 'live'].includes(env.PAYSTACK_MODE ?? '') || (key && !key.startsWith(`sk_${env.PAYSTACK_MODE}_`))) missing.push({ name: 'PAYSTACK_MODE', description: 'Must be test or live and match the secret key' });
    if (env.NODE_ENV === 'production' && !env.BACKEND_PUBLIC_URL?.startsWith('https://')) missing.push({ name: 'BACKEND_PUBLIC_URL', description: 'Checkout requires an HTTPS public backend URL' });
    if (env.NODE_ENV === 'production' && !['redis', 'firestore'].includes(env.RUNTIME_LIMIT_STORE ?? '')) missing.push({ name: 'RUNTIME_LIMIT_STORE', description: 'Checkout requires distributed rate limits in production' });
  }
  if (env.PAYSTACK_WEBHOOK_SECRET && !env.PAYSTACK_WEBHOOK_SECRET.startsWith('whsec_')) missing.push({ name: 'PAYSTACK_WEBHOOK_SECRET', description: 'Expected a whsec_ signing secret' });
  if (env.STORE_FULFILLMENT_URL) {
    try {
      const url = new URL(env.STORE_FULFILLMENT_URL);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error();
    } catch { missing.push({ name: 'STORE_FULFILLMENT_URL', description: 'Use a fixed HTTPS URL without credentials, query, or fragment' }); }
    if ((env.STORE_FULFILLMENT_TOKEN?.length ?? 0) < 32) missing.push({ name: 'STORE_FULFILLMENT_TOKEN', description: 'Receiver authentication token must be at least 32 characters' });
  }
  return { service: 'Store checkout', missing };
}
