# CheFu User Management

The `UserManagement` Next.js app uses the existing CheFu Account sign-in and
shared `__session` cookie. It sends `x-chefu-app: admin` and credentialed requests.
No Firebase service credentials or tokens are exposed to the browser.

Deploy the backend module before deploying the console. All routes are under
`/admin/user-management` and require `AuthGuard` plus `UserManagementGuard`.
The latter rechecks central profile roles and Firebase disabled status on every
request, regardless of signed session metadata.

- `GET /session`: signed-in administrator identity.
- `GET /users?limit=25&cursor=<email>&search=<email-prefix>`: central profile
  pagination in email order, joined to Firebase Auth for verification/status.
  Maximum page size is 100; missing Firebase accounts show `Unavailable`.
- `GET /summary?days=7|30|90`: Firestore aggregate counts and UTC registration
  intervals. Active means `lastLoginAt` within 30 days. New means `createdAt`
  within 30 days. Accounts with no historical timestamp are included in total,
  but cannot contribute to date-based statistics. Roles show canonical `admin`
  versus other accounts; profiles can hold other product roles.
- `PATCH /users/:uid`: `{ disabled?: boolean, role?: user|admin|moderator|support }`.
  Changes to your own account are prohibited. Unrelated product roles remain.
  Suspension and role edits revoke Firebase sessions and publish the existing
  subject-revocation event for OAuth access tokens. Enabling does not verify email.
- `GET /audit?cursor=<event-id>`: cursor-paged management audit history, newest first.
  Attempts are persisted before mutation and marked completed or failed afterward.
  A failed operation may have applied part of its change; refresh before retrying.

The console's status/role filters and name sort apply to the current page;
email-prefix search and pagination run on the server. CSV exports the visible
page, with quoting and spreadsheet formula protection. No full user collection
scan or settled permission cache is introduced.

Production account return URLs for `app=admin` allow `https://admin.chefu.co.za`
and the existing `https://internal.chefu.co.za`. Both origins are registered in
the backend CORS/CSRF allowlist. Deploy both the API and CheFu Account changes
to enable the admin host; changing only this console does not update either
service's production allowlist.

Local development: API `:4000`, CheFu Account `:3001`, console `:3000`. Set the
console's `NEXT_PUBLIC_API_BASE_URL` and `NEXT_PUBLIC_ACCOUNT_APP_URL` accordingly.
Add both frontend origins to backend `FRONTEND_ORIGINS`, and use local cookie
settings (no production cookie domain, HTTP-compatible secure setting). Sign in
through the local Account app; production-domain cookies are not sent to localhost.

Validate with `npm run typecheck`, `npm run build`, and
`node --import tsx --test src/modules/user-management/user-management.spec.ts`.
Tests use isolated adapters and never connect to production Firebase.
