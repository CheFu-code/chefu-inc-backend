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
- `x-chefu-app: flow`
- `x-chefu-app: music`

Flow's existing `x-flow-session` header still works and still enforces the
Flow sender allowlist.

## Production Environment

Set these on the backend host:

- `FRONTEND_ORIGIN=https://chefuinc.com`
- `AUTH_COOKIE_DOMAIN=.chefuinc.com`
- `AUTH_SESSION_SECRET=<long random secret>`
- Firebase Admin credentials using either `FIREBASE_SERVICE_ACCOUNT` JSON or `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
- `GEMINI_API_KEY`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_SYSTEM_USER_TOKEN`
- `RESEND_API_KEY` for security notification emails
- `SIGNIN_ALERT_TEMPLATE_ID` if using a saved Resend template for sign-in alerts
- `PASSWORD_CHANGED_TEMPLATE_ID` if using a saved Resend template for password-change alerts
- `KEEPALIVE_PING_URL` is optional; on Render the cron defaults to `RENDER_EXTERNAL_URL/health`

On the frontend host, set:

- `NEXT_PUBLIC_API_BASE_URL=https://api.chefuinc.com`

## Keepalive Cron

The backend uses `node-cron` to ping the health endpoint every 14 minutes. Set
`KEEPALIVE_PING_URL` if you want to force a specific public URL, for example:

- `KEEPALIVE_PING_URL=https://your-render-service.onrender.com/health`

If `KEEPALIVE_PING_URL` is empty, the service uses `RENDER_EXTERNAL_URL/health`
on Render, then falls back to `http://127.0.0.1:${PORT}/health`.

## Routes

- `GET /health`
- `POST /auth/session`
- `GET /auth/me`
- `DELETE /auth/session`
- `POST /ai/generate`
- `POST /admin/delete-user`
- `POST /admin/send-otp`
- `POST /email/password-changed`
