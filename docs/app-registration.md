# Application registration

Deploy the backend, `CheFu-Account`, and `UserManagement` together once to enable
this feature. Subsequently administrators can register new apps from the console's
**Apps** section without editing backend or Account source allowlists.

## Registration

Each registration is an OAuth client with an app ID, client ID (generated when
omitted), display name, owner email, exact web origins, exact callback URLs, client
type, identity scopes, and pending/active status. Additional clients can share a
new app ID, for example separate public web and mobile clients. Built-in platform
app IDs and OAuth clients are reserved and remain managed in source configuration.

Use HTTPS for deployed web origins/callbacks. Only loopback development hosts may
use HTTP. Origins contain no path or trailing slash. A web callback must belong to
a registered origin. Public native clients can use an exact custom-scheme callback,
such as `myapp://callback`, with no web origin. Wildcards, credentials, fragments,
unsafe URL schemes, and arbitrary scopes are rejected. Available scopes are
`openid`, `profile`, and `email`; `openid` is required.

Browser and mobile apps are public clients and must use S256 PKCE. Confidential
clients also use PKCE and supply `client_secret` to the token endpoint from their
server. Secrets are returned only at registration/rotation, stored as bcrypt
hashes, and excluded from list and public policy responses. Rotation atomically
changes the active secret version; previous secrets immediately stop matching.
Registration does not grant product-specific roles or server-to-server access.

## Runtime behavior

- `GET /admin/apps` returns built-in definitions and the newest 200 registrations.
- `POST /admin/apps/register` creates the registration and audit event atomically.
- `POST /admin/apps/:clientId/approve` validates and activates a registration.
- `POST /admin/apps/:clientId/revoke` removes runtime trust.
- `POST /admin/apps/:clientId/rotate-secret` rotates confidential credentials.

All management routes require `AuthGuard` and `UserManagementGuard`, including
fresh central admin-role and Firebase account-disabled checks. The audit actor is
taken from the authenticated request. Clients cannot supply approval identity.
Audit records are written to `app_registry_audit`.

Active managed records in `oauth_apps` carry `registry_version: 1`. Older records
are visible but untrusted until an administrator reviews and activates them through
the validated endpoint. No legacy document is silently promoted. List responses
omit stored secrets and tolerate missing legacy configuration arrays.

App ID resolution, OAuth client resolution, dynamic CORS, and cookie CSRF origin
validation consult the database. Changes apply across backend instances without
restart. Existing static origin/client definitions continue to work independently.
There is no backend registry cache that could retain revoked trust. An app ID's
policy aggregates up to 100 client registrations. Avoid exceeding that bound.

`GET /apps/policy/:appId` returns only public sign-in configuration: name, origins,
client IDs, callbacks, and scopes. It returns 404 for unknown/revoked apps and uses
`Cache-Control: no-store`. Account middleware fetches this policy for non-built-in
apps, validates return URLs against it, and passes it to the auth UI. Incoming
policy headers are discarded; registry failures fail closed. Account policy reads
are fresh even though the admin console intentionally caches its app list.

Web integrations send `x-chefu-app: <appId>` with credentialed API requests and
navigate to `https://myaccount.chefu.co.za/login?app=<appId>&returnTo=<encodedURL>`.
OAuth integrations use `/oauth/authorize` and `/oauth/token` with the registered
client ID, exact callback, unpredictable state/nonce, and S256 PKCE. The console
shows these integration details after activation. OAuth refresh issuance still
follows the deployment's `OAUTH_ENABLE_REFRESH_TOKENS` setting.

Revocation blocks new app-specific sign-ins, authorizations, code exchanges, and
token refreshes. Existing access tokens/shared account sessions are not destroyed
by app revocation and may remain valid until normal expiry. Do not rely on an app
registration as product-specific resource authorization.

## Validation

Run `npm run test:apps`,
`npm run test:security`, `npm run test:user-management`, and `npm run build`.
Account redirect tests include dynamic policies and tampered OAuth callbacks.
