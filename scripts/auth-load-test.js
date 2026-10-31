// k6 staging-only authentication load test.
// Usage:
// AUTH_LOAD_BASE_URL=https://staging-api.example.test AUTH_LOAD_USERS_FILE=./staging-users.json \
// k6 run --vus 10 --duration 1m scripts/auth-load-test.js
// staging-users.json must be gitignored, use unique isolated accounts with no personal data.
import http from 'k6/http';
import { check, sleep } from 'k6';

const baseUrl = __ENV.AUTH_LOAD_BASE_URL;
if (!baseUrl) throw new Error('AUTH_LOAD_BASE_URL is required.');
const parsed = new URL(baseUrl);
if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
  throw new Error('Load tests require HTTPS outside localhost.');
}
if (parsed.hostname === 'api.chefu.co.za' || parsed.hostname === 'myaccount.chefu.co.za') {
  throw new Error('Production hosts are intentionally blocked; test against staging only.');
}

const mode = __ENV.AUTH_LOAD_MODE || 'session';
const credentialsPath = __ENV.AUTH_LOAD_USERS_FILE;
const users = mode === 'login'
  ? JSON.parse(open(credentialsPath || './staging-users.json'))
  : [];
if (mode !== 'login' && mode !== 'session') throw new Error('AUTH_LOAD_MODE must be session or login.');
if (mode === 'login' && (!Array.isArray(users) || users.length === 0)) {
  throw new Error('Login testing needs unique staging test accounts.');
}

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-vus',
      vus: Number(__ENV.AUTH_LOAD_VUS || 10),
      duration: __ENV.AUTH_LOAD_DURATION || '1m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<2000'],
  },
};

export default function () {
  const headers = { 'x-chefu-app': 'root' };
  if (mode === 'session') {
    const response = http.get(`${baseUrl}/auth/session/status`, { headers });
    check(response, { 'session status succeeded': r => r.status === 200 });
  } else {
    // Each VU must use its own account. Shared users will trigger per-email
    // lockouts and make performance readings meaningless.
    if (!users[__VU - 1]) throw new Error('Provide at least as many staging accounts as VUs.');
    const account = users[__VU - 1];
    const response = http.post(`${baseUrl}/auth/session/password`,
      JSON.stringify({ email: account.email, password: account.password, trustDevice: false }),
      { headers: { ...headers, 'Content-Type': 'application/json' } });
    check(response, { 'login succeeded': r => r.status === 200 });
  }
  sleep(1);
}
