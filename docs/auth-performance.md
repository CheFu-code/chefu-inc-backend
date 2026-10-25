# Shared sign-in and signup performance

These changes apply to the shared auth backend, including CheFu Account and SSO clients.

| Operation | Before | After |
| --- | --- | --- |
| Password browser session | Minted an unused custom token | Uses the verified ID token directly |
| Non-admin session profile lookups | Two `getUserProfile` reads | One fresh read after profile synchronization |
| Profile persistence | Two sequential commits | One atomic batch containing the same two merge writes |
| Signup welcome email | Response waited for delivery request | Runs after successful response, with a 10-second timeout |

Legacy `/auth/login` still returns its custom token. Signup still needs its custom token to establish a verified session. Admin access still checks current roles before session creation. Final role/profile metadata is read fresh; no authorization cache was added.

Revocation checks, recent-sign-in enforcement, verified-email checks, MFA, trusted-device validation, rate limits, registration challenge claims and security activity remain on their existing awaited paths. Only the informational welcome email moved after the response. Verification emails and device-trust challenges remain awaited.

## Cost and delivery

Normal non-admin session creation removes one Firestore document read. Batching retains the same two billable profile writes; it reduces sequential network round trips, not write billing. No queue, scheduled job, new database counter, retry loop or hosting change was added.

Welcome requests use a hashed account UID as the Resend idempotency key. Resend deduplicates matching keys for 24 hours ([provider documentation](https://resend.com/docs/dashboard/emails/idempotency-keys)). Welcome delivery remains best effort: process shutdown after response can lose this informational email. Failures are logged and do not invalidate a completed signup. Guaranteed delivery would require a durable queue/outbox, deliberately omitted here to avoid extra infrastructure and writes.

## Existing SSO sessions

CheFu Account's login and registration pages check `/auth/session/status` before mounting their forms. A verified session continues to the already allowlisted destination, including an unchanged OAuth authorization URL (state, nonce, PKCE and callback remain intact). Explicit `prompt` requests and auth-page destinations do not auto-continue. A missing, expired, revoked or unverified session shows the normal form; network failures and the 3-second client timeout also fall back to the form.

The status endpoint verifies the HttpOnly session cookie with revocation checking and returns only an authentication boolean, with `private, no-store`. It performs no profile synchronization, session renewal, email sending or application database writes. Ordinary apps need no profile read; Admin requires current roles and Flow requires its existing access check. Existing API rate limits still apply, including their configured storage costs. Only concurrent browser checks are coalesced; decisions are never persisted or cached across navigation/logout. The check runs in the browser to support API-host-only cookies, not just cookies shared with the Account domain.

The existing `/oauth/authorize` endpoint still independently validates the session and registered client/redirect/PKCE before issuing a code. Target resources continue to enforce their own authorization. This is session reuse, not an extension of session expiry. Both the backend and Account app must be deployed. Browsers/private sessions without the existing cookie must sign in normally.

## Timing inspection

### Concurrent client reads

Account shares concurrent `/auth/me` and session-status requests per app, including React development remounts. Consumers share parsed data, not a consumed `Response` body. Results are discarded when requests settle; errors can be retried normally. Sign-in, MFA, registration verification, passkey completion, sign-out, profile/photo updates and account deletion invalidate pending reads before and after their mutation, preventing an older response from overwriting the new account state. Full-profile reads stay separate from the lightweight session-status probe.

LiftWise shares concurrent userinfo requests for the exact access token. Onboarding refresh sharing also requires the same token and preference revision, so a newly updated profile/token does not join an older request. After code exchange, independent userinfo and onboarding requests run together and both must complete before publishing the session. Existing refresh-token rotation sharing and server-side authorization/revocation checks remain unchanged. No additional requests, packages, database writes, or persistent authorization caches were added by these client changes.

### Timing headers

Inspect the auth request's `Server-Timing` response header in browser developer tools: `password`, `verify_token`, `session_cookie`, `profile_sync`, `trusted_device`, and `profile_read` report milliseconds. They contain no credentials or account identifiers and create no persistent logs/database operations. The stages do not cover all work, so also compare total request time. Admin prechecks and additional trust challenges are not separately timed.

Compare repeated warm requests separately from the first request after idle. Hosting cold starts, region distance, Firebase and email-provider latency still affect end-to-end speed. No production latency reduction is claimed until measured after deployment.

Validation: all 39 backend security tests pass; the previously run 34 LiftWise backend tests and backend build pass. Client checks pass: 14 Account SSO/trusted-browser tests, 15 LiftWise auth tests, 3 onboarding tests, both client TypeScript checks, and Account lint on changed files. No web compilation. Full backend `npm run typecheck` previously reported existing errors in Cloudence test types and a LiftWise test's Node16 dynamic import resolution.
