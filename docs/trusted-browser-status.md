# Trusted-browser status protections

`POST /auth/trusted-devices/status` is an optional pre-login UI hint. It never authenticates a user or changes device trust. Actual sign-in continues to perform fresh account/expiry/revocation checks.

The Account app debounces typing for 600ms, normalizes emails, cancels obsolete checks, uses a bounded 30-second memory cache, spaces requests by at least two seconds and caps requests at six per minute per mounted form. Focus events reuse fresh results. HTTP 429 honors the server's retry period across email changes; network/server errors pause checks for 15 seconds. When status cannot be checked, the trust checkbox remains available and sign-in is not blocked.

Server safeguards run independently of the browser:

- 60 status requests per IP per minute, using Express's configured trusted-proxy handling.
- 12 requests per trusted-cookie hash per minute, independent of submitted email.
- At most 100 uncached browser lookups per minute per process, with a separate non-evictable budget to resist identifier rotation.
- At most eight concurrent cold lookups per Firebase Admin instance.
- Up to 1,000 cookie-hash cache entries. Concurrent requests coalesce; changing emails compares against the cached owner internally. Positive hints cache for 30 seconds, negative results for 10 seconds. Actual expiry is checked even on cache hits. No email, UID, cookie or cookie hash is returned.
- Missing/malformed cookies and malformed emails return false before Firestore access. A well-formed random cookie still requires an existence lookup, subject to the cold-lookup budget.
- No Firestore writes or rate-counter transactions for this endpoint, even if platform-wide RUNTIME_LIMIT_STORE uses Firestore. Normal endpoints retain their existing limiter. Expected status throttling returns 429 and Retry-After without flooding the global exception/Sentry logs.

These are **process-local** budgets; restarts reset them and multiple processes have independent budgets. Use the existing hosting/proxy/WAF layer for fleet-wide volumetric protection if deployment scale requires it. No Redis, paid infrastructure or new dependency was added. Each cold lookup can read one or two Firestore documents plus a Firebase Auth record, so the cold-lookup budget is not an exact billable-read cap. Cache tests measure SDK calls, not production billing.

A UI hint can be stale for up to 30 seconds following external revocation. It cannot bypass the fresh trust validation at sign-in. The browser cache contains only bounded email/boolean entries in memory, not persistent storage or authentication credentials.

Verification: four Account browser-status tests (including rate-limit backoff, cache reuse and cross-email response races), Account typecheck/targeted lint, 26 backend security tests, and backend build. Tests assert twelve email checks share one document lookup and one Auth lookup in the isolated adapter, that throttled requests add no lookups, and that cold-lookup limits survive LRU pressure. No production requests, deployments or web build were performed.
