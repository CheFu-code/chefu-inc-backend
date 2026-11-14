# Phone verification

Authenticated contact-number verification using Twilio Verify. This module does not change sign-in, account recovery or MFA, and does not treat the mobile application's contact-number checkbox as SMS verification.

## API

All routes use the existing central `AuthGuard` (OAuth/Firebase bearer or central session cookie). User identity comes only from that guard. Cookie mutations retain the backend's trusted Origin/Referer protection. Responses use `Cache-Control: private, no-store`.

- `POST /phone-verification/send`: `{ "phone": "..." }`. Returns normalized phone, verification state, expiry and resend delay.
- `POST /phone-verification/check`: `{ "phone": "...", "code": "..." }`. Returns `verified: true`, phone and server verification date only after provider approval is persisted, or for the account's already verified phone.
- `GET /phone-verification/status`: returns only the signed-in account's saved verification state.

The central SSO signup offers an optional phone modal after email verification and before the passkey offer. On a fresh approval, the verification receipt and `users/<authenticated email>.phone` contact are committed together. The email comes only from `AuthGuard`; the request cannot choose another profile. This saves contact details without enrolling Firebase phone sign-in or SMS MFA. Skipping the modal makes no phone API calls. Existing receipts remain historical proof; editing a profile contact does not change those receipts.

## Current contact and required verification

`users/<email>.phone` is the canonical contact, normalized to E.164. The backend sets `phoneVerifiedAt` and binds it to `phoneVerifiedFor` in the same transaction as the approved receipt. Both must match the current number. Clients must never be permitted to write these verification fields, receipts, migration markers or account identity/roles directly. An editable contact or Firebase Authentication's `phoneNumber` property alone is not verification evidence.

An account with a saved, unverified number must confirm that number or verify a replacement before continuing through SSO. Users without a number retain the optional signup offer. The required modal has no Skip action; it permits signing out. An unverified contact cannot be removed through the profile API to evade the requirement. Changing the normalized contact clears its proof transactionally; saving the same number preserves proof. Profile updates no longer write Firebase Authentication's phone sign-in property. `/auth/me` no longer imports old Auth numbers into empty contacts.

The server checks current contact state before OAuth authorization-code issuance, code exchange, refresh rotation, user access-token use and delegated user-token use. Pending OAuth authorization redirects to the central `/verify-phone` route while retaining the validated OAuth request. Standard `AuthGuard` application endpoints (including ShopYethu admin) enforce the same gate. Central `/auth/*` account/recovery routes and exact OTP routes remain accessible; `/auth/shopyethu/*` is an application route and is not exempt. Existing signed tokens and browser cookies do not bypass the gate. Custom API-key endpoints and unrelated authentication schemes do not acquire this policy automatically.

Cost: password/passkey session completion computes the flag from the existing profile load; no extra OTP/receipt/provider lookup occurs. Profile serialization and downstream role checks share a read within one request. The session-reuse probe now reads one current profile (it previously read none for ordinary users). Application requests that previously relied only on token/signed metadata need one current profile read; that read is shared with other authorization/profile checks in that HTTP request. OAuth refresh needs a transactional profile read. These checks do not write verification state or send SMS. No settled authorization cache is introduced, so a changed phone is enforced on subsequent requests.

Switching to a saved account loads that selected profile once and includes the flag in the switch response, avoiding a subsequent HTTP status request. Choosing the already active account uses one normal session probe. Account deletion removes contact/proof fields and both private phone documents. Application-specific contact fields (for example a seller application's contact number) remain separate; this policy does not certify those as matching the account number.

## One-time legacy migration and rollout

The offline migration reads `users` in pages of 100, normalizes `phone` / legacy Firestore `phoneNumber`, and reconciles only matching UID-owned Twilio receipts. It never assumes Firebase Auth phone presence proves OTP ownership. A matching legacy alias is removed; conflicting values are preserved, flagged with `phoneMigrationConflict` and left unverified for review or user verification. Invalid values remain unverified. It uses fresh transactions when applying, is resumable/idempotent and never logs numbers or emails. Legacy users without UID need an Auth lookup during this offline job only. Already migrated/edited contacts cannot regain verification from an old receipt on rerun.

```sh
npm run migrate:phone-contacts             # read-only dry run; reports counts
npm run migrate:phone-contacts -- --apply  # applies to the configured Firebase project
```

Deploy the central UI with `/verify-phone` first. Configure and test real Twilio delivery, the enabled phone service, distributed limiter and deployed Firestore rules before activating this backend enforcement; otherwise users with unverified numbers cannot continue. Review a migration dry run and resolve reported conflicts/invalid records. Run the migration with `--apply` only against the intended project, then confirm a second dry run is stable. Database migration, live SMS testing and deployment have not been run by this change.

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
