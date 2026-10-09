# Nook Matrix homeserver

This is an isolated Synapse deployment for Nook direct messages. It is separate
from the NestJS API, uses PostgreSQL plus a persistent Fly volume, accepts Chefu
Account OIDC sign-in with PKCE, and disables open registration, passwords, URL
previews, public room discovery, and federation. Only serve encrypted Matrix
rooms from Nook clients; do not send plaintext message content to this service
or to the NestJS API after the E2EE client rollout.

Encryption must be enforced by the Nook clients: Synapse itself does not reject
unencrypted room events. The homeserver will still see account/device IDs, room
membership, message timing and sizes, and other Matrix routing metadata.

The Nook app is **not yet migrated** to Matrix. Do not advertise E2EE or direct
users to this homeserver until the native and web clients, device verification,
key backup/recovery, push privacy, and migration tests are complete.

## Prerequisites

- A Fly.io app named `chefu-nook-matrix`.
- A PostgreSQL database reachable from that Fly app over TLS/private networking.
  Create and operate it separately from Synapse; do not use SQLite for production.
- DNS and a TLS certificate for `matrix.chefu.co.za`.
- The CHEFU API deployed with the `nook-matrix-synapse` public OAuth client from
  `src/modules/apps/app-registry.ts`.
- The production Nook web origin `https://nook.chefu.co.za`, used to allowlist
  the web SSO callback. The startup script fails if it is missing or is not an
  HTTPS origin.

## Initial deployment

From the backend repository root, provision the app and persistent media/key
volume, then set the database connection and exact Nook web origin as Fly secrets:

```powershell
fly apps create chefu-nook-matrix
fly volumes create matrix_data --region iad --size 10 --app chefu-nook-matrix
fly secrets set --app chefu-nook-matrix SYNAPSE_DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require" SYNAPSE_WEB_ORIGIN="https://nook.chefu.co.za"
fly deploy --config deploy/nook-matrix/fly.toml deploy/nook-matrix
fly certs add matrix.chefu.co.za --app chefu-nook-matrix
```

Use the actual PostgreSQL credentials only in the interactive Fly secret command;
never put them in this repository, shell history, or deployment logs. Configure
DNS using the records Fly reports for the certificate. Keep the database
credentials in a Fly secret, use TLS for database connections, and back up both
the database and the `matrix_data` volume.

The Synapse container generates its runtime config from the checked-in template
and Fly secrets on each start. It writes that config only to the ephemeral
machine filesystem; the signing key and media store live on `/data`. The
container fails at startup if the database URL or web origin is missing or
invalid.

## Validation after deployment

1. Confirm `https://matrix.chefu.co.za/health` responds successfully.
2. Confirm `https://matrix.chefu.co.za/_matrix/client/versions` responds.
3. Verify the Synapse SSO provider uses the CHEFU API, client ID
   `nook-matrix-synapse`, PKCE, and the exact callback URL
   `https://matrix.chefu.co.za/_synapse/client/oidc/callback`.
4. Verify first-time SSO users are provisioned by the CHEFU OIDC provider, while
   password registration, global/open registration, and federation remain
   unavailable.
5. Do not send production conversations until the E2EE client and recovery flow
   have passed their rollout gates.
