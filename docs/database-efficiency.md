# Backend read/write efficiency audit

Source review covers the shared Firebase layer and the Academy mobile/SDK, AI,
API key, apps, auth/SSO, Cloudence, courses, email, health, LiftWise,
notifications, products, Quantum, and submissions modules.

## Implemented savings

Counts below are verified with isolated adapters against the real service methods.
They exclude authentication guards and SDK transaction retries, which still run.

| Operation | Before | After |
| --- | --- | --- |
| Save unchanged notification preferences | 1 document read, 1 write | 1 read, 0 writes |
| Academy settings with email preferences | 2 reads, 1 write | 1 transactional read, 0 writes if unchanged or 1 if changed |
| Repeat API key revocation, general and Academy SDK APIs | 1 read, 1 write | 1 read, 0 writes |
| Edit a message with identical content and metadata | 1 transactional read, 1 write | 1 transactional read, 0 writes |
| Unchanged product update or repeat archive | 1 product read, 1 product write, 1 audit write | 1 product read, 0 writes |
| Rename a folder to its existing name, or move an already placed file | Settings write on every request | No settings write when normalized state, including cleanup cursor, is unchanged |
| Concurrent reads of the same Academy SDK course or Quantum tools catalog | One database query per caller | One query shared by simultaneous callers of the same service |

Changed preferences still persist. Preference updates use a transaction to preserve
concurrent changes, and return the computed response without a second read.
Real product changes still write their audit records. Folder operations still
validate file access and persist cleanup progress when it changes.

`InFlightReads` shares only pending public catalog reads. It does not cache settled
results or failures, is bounded to 128 pending keys per instance, and does not
share data between service instances. Subsequent reads fetch fresh data.

## Existing protections retained

- SSO token/session verification, revocation checks, and ownership checks remain fresh.
- Security events, rate-limit counters, replay protection, credential rotation,
  sign-in timestamps, and quota transactions retain their existing behavior.
- LiftWise already uses bounded/paged reads, read caching with mutation invalidation,
  aggregate summaries, and idempotent session completion writes.
- Cloudence already shares quota loads, caches informational owner names, and uses
  authoritative transactional quota checks. Its file authorization is not cached.
- Products and Academy mobile/SDK lists already have cache/request-sharing logic.
- Quantum histories and schedule polling already have query limits.
- Courses retain fresh ownership, membership, download-limit, and progress checks.
- Contact/career submissions and email delivery state retain their durable records.

## Limits and further work

This is a source audit and tested optimization pass, not a measurement of production
billing. Actual savings depend on traffic, repeated saves, concurrency, and Firestore
transaction retries. No production data was changed or migrated.

Some catalog/admin/export/cleanup paths still read full matching collections.
Replacing those with pages or aggregates requires a compatible client/API design;
silently applying limits would omit data. Presence/last-used timestamps, workflow
leases, security logs, and completion history are intentional writes, not candidates
for blanket suppression. Cross-instance cache invalidation would require an explicit
distributed design; no new long-lived authorization cache was introduced here.

## Validation

Run `npm run test:efficiency` for operation-count tests and `npm run typecheck` for
TypeScript validation. The full local source test run passed 160 tests, including
auth, Cloudence, LiftWise, Quantum, security middleware, and the new efficiency tests.
The Firestore-emulator-only suite requires its separate emulator setup and was not
part of that run.
