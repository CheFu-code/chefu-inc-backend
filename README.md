# CheFu API

Separate NestJS backend for deployment at `https://api.chefuinc.com`.

## Local Development

```bash
cd backend
npm install
npm run dev
```

The API listens on `PORT` or `4000`.

## Production Environment

Set these on the backend host:

- `FRONTEND_ORIGIN=https://chefuinc.com`
- `AUTH_COOKIE_DOMAIN=.chefuinc.com`
- `AUTH_SESSION_SECRET=<long random secret>`
- Firebase Admin credentials using either `FIREBASE_SERVICE_ACCOUNT` JSON or `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
- `GEMINI_API_KEY`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_SYSTEM_USER_TOKEN`
- `PASSWORD_CHANGED_API_URL` if using the email proxy endpoint

On the frontend host, set:

- `NEXT_PUBLIC_API_BASE_URL=https://api.chefuinc.com`

## Routes

- `GET /health`
- `POST /auth/session`
- `DELETE /auth/session`
- `POST /ai/generate`
- `POST /admin/delete-user`
- `POST /admin/send-otp`
- `POST /email/password-changed`
