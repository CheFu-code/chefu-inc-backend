# Centralized authentication: throughput, cost and rollout

## What changed
- `/auth/me` fetches the account profile and Firebase user concurrently, and
  stops updating the detected-country field for every page view. It updates
  only on country change or after 24 hours, using the existing profile read.
  Missing phone data is still persisted before returning it.
- After required token verification and profile synchronization, session
  creation overlaps the independent trusted-device validation and fresh
  profile read. It never sets cookies until all required checks complete.
- Trusted-device checks always revalidate credential changes, revocation and
  expiry. The informational last-seen timestamp is refreshed at most every
  15 minutes rather than every sign-in.
- `RUNTIME_LIMIT_STORE=redis` enables atomic distributed Redis fixed-window
  rate limits and replay protection (using the existing `ioredis` dependency).
  `RUNTIME_LIMIT_STORE=firestore` remains supported; `memory` is appropriate
  only for single-instance development/testing. Configured distributed
  stores now fail closed by default if unavailable.
- The main CI workflow includes security, LiftWise and Cloudence regression
  suites. No authentication APIs, MFA requirements, OAuth redirects, cookie
  format or response contracts were intentionally changed.

## Production deployment checklist (required before load scaling)
1. **Confirm the runtime store in the real deployed environment.** Set
   `RUNTIME_LIMIT_STORE=redis` with `RUNTIME_LIMIT_REDIS_URL=rediss://...`,
   or `RUNTIME_LIMIT_STORE=firestore` if Redis is not provisioned. Do not assume
   the example environment file configures the deployment.
2. Redis should be private-network-only, authenticated, TLS protected and
   configured with adequate memory and a **noeviction** policy. If replay
   entries are evicted early, DPoP replay protection can weaken. Do not
   share this Redis database with untrusted workloads. Use a managed HA
   deployment, monitor latency, failures, memory and availability. Do not
   put Redis credentials into the repo or logs.
3. Distribute clients across instances and regions appropriately, but keep
   compute close to Firestore/Firebase resources. Review Firestore index
   exemptions, read/write quotas, Firebase Auth quotas, instance limits,
   CPU, memory and connection settings. Scale gradually.
4. Existing login per-IP limits are intentionally strict. Large carrier NAT
   networks and load generators sharing one IP can hit `20 / 15 minutes`
   even for different users. Validate real-world 429 rates before tuning
   thresholds or deploying bot defenses at the edge.
5. Alert on 401/403/429/503 rates, p50/p95/p99 latency, Firebase errors,
   Redis failures, Firestore transaction retries/contention, session
   revocation failures, and costs. Use the request ID to correlate logs
   without logging credentials or raw tokens.
6. Do not cache revocation-checked session decisions, sensitive roles,
   OAuth grant validation or replay results across requests. Security
   correctness remains more important than a faster but stale cache.
7. Review the actual dependency vulnerability report; do not apply breaking
   `npm audit fix --force` updates blindly. Keep dependency alerts enabled.

## How to validate in a safe staging environment
- Run `npm ci && npm run typecheck && npm run build && npm run test:security`.
- Also run `npm run test:liftwise` and `npm run test:cloudence`.
- Test password sign-in, passkeys, registration, MFA, trusted-device challenge,
  revoked sessions, password resets, logout, Admin and Flow permissions,
  and cross-app OAuth authorization-code callbacks.
- Check `Server-Timing` on the login and `/auth/me` responses. Compare
  p50/p95/p99 at equal traffic and with warm/cold instances separately.
  Never describe latency improvements as measured until staging and
  production metrics confirm them.
- For **read-only session-status** load: install k6 and run
  `AUTH_LOAD_BASE_URL=https://staging.example.test AUTH_LOAD_MODE=session AUTH_LOAD_VUS=10 k6 run scripts/auth-load-test.js`.
- For **login bursts**, create isolated, unique test accounts and an
  untracked JSON file of objects `[{ "email": "...", "password": "..." }]`.
  Run `AUTH_LOAD_BASE_URL=https://staging.example.test AUTH_LOAD_MODE=login AUTH_LOAD_USERS_FILE=/secure/staging-users.json AUTH_LOAD_VUS=10 k6 run scripts/auth-load-test.js`.
  Login burst mode performs exactly one login per virtual user, never
  repeatedly guesses credentials. Production API/account hosts are blocked.
  Ramp slowly, distribute load-generator IPs, and coordinate quota changes
  with Google before tests above default limits. Do not test against
  personal accounts. A clean test should include genuine session creation
  and MFA/trusted-device edge cases, not only `/auth/session/status`.

## Unit costs and realistic savings (not production measurements)
- Country update: up to **one Firestore document write avoided per
  unchanged-country `/auth/me` request** that previously produced a write.
  This is zero when no country header was provided; country changes and
  daily refreshes continue to write. The profile read itself is retained.
- Trusted-device activity: up to **one write avoided per repeat login**
  within a 15-minute window. Validity checking reads and credential-change
  invalidation remain in place.
- `RUNTIME_LIMIT_STORE=redis`: when replacing the previous **Firestore
  runtime-limit mode**, eliminates corresponding Firestore rate-limit
  transactions. A typical password login has 1 API limiter reservation
  plus 2 email/IP reservations, so in that configuration it could avoid
  roughly **3 document reads and 3 document writes per attempt**, before
  accounting for other checks. Replay keys also move to Redis.
  If the old store was memory, there were no such Firestore charges, and
  Redis adds an infrastructure bill.
- At **one million qualifying operations**, one avoided Standard-edition
  Firestore write is about **USD $0.90** and one avoided read about
  **USD $0.30** at illustrative us-central1 rates, beyond free quota.
  Three of each: about **USD $3.60** per million login attempts.
  Actual costs depend on region, edition, free quota, retries, Redis
  hosting, outbound bandwidth and compute. Redis is chosen primarily
  for distributed correctness and lower hotspot risk, not guaranteed
  overall cost reduction.
- Overlapping independent reads reduces critical-path waiting
  approximately from `A+B` to `max(A,B)` for the overlapped portion,
  not for the entire sign-in. The real latency delta is unknown until
  measured. User-visible payload schemas have not changed, so no
  specific browser bandwidth saving is claimed.

## Are 1,000 simultaneous sign-ins safe?
**Not proven.** An inbound 1,000-client burst can exhaust application
concurrency, Firebase Authentication quota, Firestore write throughput
or shared rate-limit capacity, depending on deployment settings and
source IP distribution. The per-IP login limit may intentionally return
429 for large numbers sharing one IP. Review load-test outcomes and
quotas before promising SLAs. For example, Firebase Authentication
publishes an Identity Toolkit project quota of 180,000 requests/min,
but particular operations have lower individual limits. One thousand
simultaneous requests can also exceed instant autoscaling capacity even
when a per-minute quota appears sufficient.

Primary references:
- https://firebase.google.com/docs/auth/limits
- https://firebase.google.com/docs/firestore/best-practices
- https://firebase.google.com/docs/firestore/quotas
- https://cloud.google.com/firestore/pricing
- https://firebase.google.com/docs/auth/admin/manage-cookies
