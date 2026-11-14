# Phone verification

Authenticated contact-number verification using Twilio Verify. This module does not change sign-in, account recovery or MFA, and does not treat the mobile application's contact-number checkbox as SMS verification.

## API

All routes use the existing central `AuthGuard` (OAuth/Firebase bearer or central session cookie). User identity comes only from that guard. Cookie mutations retain the backend's trusted Origin/Referer protection. Responses use `Cache-Control: private, no-store`.

- `POST /phone-verification/send`: `{ "phone": "..." }`. Returns normalized phone, verification state, expiry and resend delay.
- `POST /phone-verification/check`: `{ "phone": "...", "code": "..." }`. Returns `verified: true`, phone and server verification date only after provider approval is persisted, or for the account's already verified phone.
- `GET /phone-verification/status`: returns only the signed-in account's saved verification state.

The central SSO signup offers an optional phone modal after email verification and before the passkey offer. On a fresh approval, the verification receipt and `users/<authenticated email>.phone` contact are committed together. The email comes only from `AuthGuard`; the request cannot choose another profile. This saves contact details without enrolling Firebase phone sign-in or SMS MFA. Skipping the modal makes no phone API calls. Existing receipts remain historical proof; editing a profile contact does not change those receipts.

Local South African numbers must have ten digits. International E.164 numbers must be valid and belong to an allowed country. Codes must contain 4–10 digits, matching the configured Verify service length. Unknown DTO properties are rejected by the existing global validation pipe.

## Deployment

Phone verification is disabled by default and missing Twilio credentials do not prevent API startup. Enable only after configuring:

```dotenv
PHONE_VERIFICATION_ENABLED=true
PHONE_VERIFICATION_ALLOWED_COUNTRIES=ZA
PHONE_VERIFICATION_DAILY_SEND_LIMIT=100
RUNTIME_LIMIT_STORE=redis
TWILIO_ACCOUNT_SID=
TWILIO_VERIFY_SERVICE_SID=
TWILIO_API_KEY_SID=
TWILIO_API_KEY_SECRET=
```

Use the backend's existing Redis connection settings. `RUNTIME_LIMIT_STORE=firestore` also provides shared limits, with additional database operations per request. Production phone verification rejects process-local memory limits. A configured shared store fails closed if unavailable. A restricted Twilio Verify API key is preferred; `TWILIO_AUTH_TOKEN` is supported when no API key is configured. Credentials stay on the server.

Set the Verify service's [Fraud Guard](https://www.twilio.com/docs/verify/preventing-toll-fraud/sms-fraud-guard) and geographic permissions for the countries you actually serve. Configure Twilio spending alerts and budgets independently. The local send ceiling counts attempts, including failed sends; it is not a guarantee about provider billing.

Firestore collections `phone_verification_challenges` and `phone_verification_verified` must deny **all direct client access**. Only backend service-account access should read or write them. Merge those restrictions into the actual deployed Firestore rules, including any broader rules that might otherwise grant access. They are not deployed by this code change. Enable Firestore TTL on the `expiresAt` field of `phone_verification_challenges` and the existing runtime rate-limit collections if using Firestore limits. Expiry is enforced by application code even before TTL cleanup runs. Verified receipts are retained separately for the account's contact status.

## Abuse and concurrency controls

Sending is limited to five attempts per account/hour, five per target/hour, twenty per source IP/hour, and the configured deployment-wide ceiling per 24-hour fixed window. Account and target resend cooldowns are 30 seconds. Checks are limited to ten per account/minute and thirty per IP/minute, plus five total provider checks per challenge. Counters use the existing `RuntimeLimitService`; the new module does not need an unconfigured `ThrottlerGuard`.

The client IP uses Express's configured trusted-proxy policy, not arbitrary forwarded headers. Rate-limit responses include retry information. Every successful send is bound to the requesting UID, target and server-stored provider SID. Checking uses that SID, never a client-supplied one. A resend of the same provider challenge retains its original expiry and attempt count. [Twilio documents a default ten-minute validity](https://www.twilio.com/docs/verify/api/rate-limits-and-timeouts); this module also enforces a ten-minute upper bound locally.

Short transactional leases serialize provider operations. Provider calls run outside retried Firestore transactions, have an eight-second timeout, and disable automatic retries. A delayed result cannot overwrite a replaced challenge. Only an approved, valid response matching the SID, phone and service can create a receipt. A confirmation retry can return the existing receipt without consuming another code. No OTPs are stored. Provider error logs contain numeric codes and operation metadata, never messages, bodies, credentials or phone numbers.

If Twilio consumes a code but the receipt cannot be committed, the API fails closed. A new code may be required; a provider 404 is never taken as evidence of approval.

## Application integration and verification

The ShopYethu seller application still uses an applicant acknowledgement of their contact number. The mobile OTP interaction and server-side requirement that an application phone match the authenticated account's verified receipt are **not connected yet**. Do not label seller contact numbers as SMS verified until both are implemented. Requiring OTP in the application endpoint before the mobile flow exists would block applications.

Saved verification is historical contact ownership, with a date. Do not use this status alone as a fresh MFA challenge, recovery factor or proof of a unique phone across accounts.

Run `npm run test:phone-verification`, `npm run test:security`, `npm run typecheck`, and `npm run build`. Tests use isolated storage/provider dependencies and do not send SMS. Before enabling production, test real sends, wrong/expired codes, delivery failures, cooldowns and concurrent requests using an authorized account and a number you control; verify the deployed shared limiter, Firestore rules, TTL and Twilio restrictions. No live SMS test or deployment has been performed by this change.
