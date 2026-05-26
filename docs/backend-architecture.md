# CheFu Inc Backend Architecture

This backend is the shared API platform for CheFu Inc products. Keep routes
stable, but organize new code by ownership and product boundary.

## Module Layers

### Platform Modules

Platform modules are cross-app foundations. They should not know about a single
product workflow.

- `apps`: registered CheFu apps, origins, and app ids.
- `firebase-admin`: Firebase Admin SDK access.
- `auth`: shared session, user identity, and guards.
- `health`: deployment and uptime probes.

### Shared Service Modules

Shared service modules provide reusable business services used by more than one
app.

- `admin`: admin-only user operations.
- `ai`: generation endpoints shared across products.
- `billing`: subscription and checkout operations.
- `email`: Resend integration.
- `notifications`: notification preferences and delivery.
- `keepalive`: Render uptime cron.

### Product Modules

Product modules own app-specific workflows and route groups.

- `academy-sdk`: public SDK API, SDK auth, developer keys, course/video catalog.
- `courses`: authenticated CheFu Academy learning and export workflows.
- `flow`: Flow Mail config, mailbox, send, and webhook flows.

Future apps should get their own product module instead of adding app-specific
logic to shared modules.

## Product Module Pattern

Use this structure for app modules that grow past one simple controller:

```txt
src/modules/<app-name>/
  <app-name>.module.ts
  <app-name>.controller.ts
  <app-name>.service.ts          # small facade when helpful
  <app-name>.types.ts
  <app-name>.constants.ts
  services/
    <focused-domain>.service.ts
```

For example, `academy-sdk` is split into:

- `AcademySdkAuthService`: SDK login/register and developer profile creation.
- `AcademySdkApiKeysService`: developer API key create/list/revoke.
- `AcademySdkCatalogService`: course and video read APIs exposed to SDK users.
- `AcademySdkService`: facade that keeps controllers thin and routes stable.

## Adding a New CheFu App

1. Add the app id and origins in `src/modules/apps/app-registry.ts`.
2. Create a product module under `src/modules/<app-name>`.
3. Keep shared concerns in shared modules. Do not copy auth, email, billing, or
   Firebase setup into product modules.
4. Import the product module in `src/app.module.ts` under `productModules`.
5. Add route docs to `README.md`.

## Route Ownership

- `/auth/*`: shared authentication and sessions.
- `/admin/*`: admin platform operations.
- `/billing/*`: shared billing.
- `/email/*`: shared email operations.
- `/api/*`: Academy SDK public API surface.
- `/courses/*`: Academy web learning workflows requiring user auth.
- `/flow/*`: Flow Mail product API.

Keep new app routes under a clear route prefix so future apps do not collide.
