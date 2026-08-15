# CheFu API

Separate NestJS backend for deployment at `https://api.chefuinc.com`.

## Local Development

```bash
cd backend
npm install
npm run dev
```

The API listens on `PORT` or `4000`.

## Apps

Shared app defaults live in `src/modules/apps/app-registry.ts`.
Add new frontend apps there once, including local and production origins.
Next/React frontends should send `x-chefu-app` when creating a session:

- `x-chefu-app: academy`
- `x-chefu-app: admin`
- `x-chefu-app: flow`
- `x-chefu-app: muzalo`
- `x-chefu-app: quantum`

Flow's existing `x-flow-session` header still works and still enforces the
Flow sender allowlist.

`x-chefu-app: music` is accepted as a legacy alias for Muzalo.

## OAuth/OIDC

CheFu API also acts as the CheFu Account authorization server. It supports the
OAuth 2.0 Authorization Code flow with PKCE and OIDC discovery:

- `GET /.well-known/openid-configuration`
- `GET /.well-known/oauth-authorization-server`
- `GET /oauth/authorize`
- `POST /oauth/token`
- `GET /oauth/userinfo`
- `GET /oauth/jwks`

Registered OAuth clients live in `src/modules/apps/app-registry.ts`. Public
browser clients must use `code_challenge_method=S256`.

## Backend Structure

This backend is organized as a shared CheFu platform plus product modules:

- Platform modules: app registry, Firebase Admin, auth, and health.
- Shared service modules: admin, AI, billing, email, and notifications.
- Product modules: Academy SDK, Academy courses, Flow, and future apps.

See `docs/backend-architecture.md` for the module pattern and the checklist for
adding a new CheFu app.

## Production Environment

Set these on the backend host:

- `FRONTEND_ORIGIN=https://chefuinc.com`
- `AUTH_COOKIE_DOMAIN=.chefuinc.com`
- `AUTH_SESSION_SECRET=<long random secret>`
- `CHEFU_ACCOUNT_URL=https://chefuinc.com`
- `OAUTH_ISSUER=https://api.chefuinc.com`
- `OAUTH_PRIVATE_KEY=<RSA private key PEM with \n escapes>`
- `OAUTH_KEY_ID=<stable signing key id>`
- `OAUTH_KEY_ID=<stable signing key id>`
- Firebase Admin credentials using either `FIREBASE_SERVICE_ACCOUNT` JSON or `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
- `FIREBASE_API_KEY` for SDK email/password login compatibility
- `GEMINI_API_KEY`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_SYSTEM_USER_TOKEN`
- `RESEND_API_KEY` for security notification emails
- `FLOW_ACCESS_SECRET=<long random secret shared with the Flow frontend>`
- `FLOW_SENDERS="CheFu Inc <hello@chefuinc.com>;Flow Mail <mail@chefuinc.com>;Support <support@chefuinc.com>;Security <security@chefuinc.com>;Muzalo <muzalo@chefuinc.com>;CheFu Academy <academy@chefuinc.com>;CheFu Quantum <quantum@chefuinc.com>"`
- `SIGNIN_ALERT_TEMPLATE_ID` if using a saved Resend template for sign-in alerts
- `PASSWORD_CHANGED_TEMPLATE_ID` if using a saved Resend template for password-change alerts

On the frontend host, set:

- `NEXT_PUBLIC_API_BASE_URL=https://api.chefuinc.com`

## Routes

- `GET /health`
- `POST /auth/session`
- `GET /oauth/authorize`
- `POST /oauth/token`
- `GET /oauth/userinfo`
- `GET /oauth/jwks`
- `POST /auth/login`
- `POST /auth/register`
- `POST /auth/refresh`
- `POST /api/auth/login`
- `POST /api/auth/register`
- `POST /api/auth/refresh`
- `POST /api/auth/verify`
- `GET /api/courses`
- `GET /api/courses/:courseId`
- `POST /api/courses/list`
- `GET /api/keys/list`
- `POST /api/keys/create`
- `POST /api/keys/revoke`
- `POST /api/keys/report-leak`
- `GET /auth/me`
- `DELETE /auth/session`
- `POST /ai/generate`
- `POST /admin/delete-user`
- `POST /admin/send-otp`
- `POST /email/password-changed`
- `GET /flow/access/session`
- `POST /flow/access/login`
- `POST /flow/access/activate`
- `DELETE /flow/access/session`
- `GET /flow/admin/access-keys` admin only
- `POST /flow/admin/access-keys` admin only
- `POST /flow/admin/access-keys/:keyId/revoke` admin only
- `GET /drippybanks/products`
- `GET /drippybanks/products/:id`
- `POST /drippybanks/upload-image` admin only
- `POST /drippybanks/products` admin only
- `PUT /drippybanks/products/:id` admin only
- `DELETE /drippybanks/products/:id` admin only
- `POST /drippybanks/products/:id/toggle-stock` admin only

