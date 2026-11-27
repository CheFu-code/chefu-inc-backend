# Cloudence Google Play subscriptions

Cloudence supports Android monthly subscriptions for **50 GiB total storage**
(not an additional 50 GiB), priced at **R69.99/month** in Google Play. The
backend remains authoritative: the app sends a purchase token, the backend
checks it with the Android Publisher API, and only then records the entitlement.
Cloudence Pro grants this quota without stacking. Purchase requests include a
one-way hash of the signed-in Cloudence
account, which the backend requires to match Google's verified purchase record.

## Google Play Console

Use this subscription product for package `za.co.chefu.cloudence`:

- `cloudence_pro_monthly`

Configure it with a monthly base plan at ZAR 69.99.
The app displays the localized price returned by Google
Play; the Play Console price is authoritative.

Enable the Google Play Developer API. Grant the billing service account these
Play Console permissions: **View financial data, orders, and cancellation survey
responses** and **Manage orders and subscriptions**. Authenticate from Fly.io
with Workload Identity Federation; no downloaded private key is required.
Follow [the keyless setup and migration steps](cloudence-google-play-workload-identity.md).

## Backend configuration

Set these backend secrets after the products and API access are ready:

```text
GOOGLE_PLAY_BILLING_ENABLED=true
GOOGLE_PLAY_PACKAGE_NAME=za.co.chefu.cloudence
GOOGLE_PLAY_WIF_AUDIENCE=//iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID
GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL=<billing service account email>
GOOGLE_PLAY_RTDN_AUDIENCE=<exact Pub/Sub push audience>
GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL=<Pub/Sub OIDC service account email>
```

`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` is no longer used. The WIF audience identifies
the Google provider and uses the **numeric project number**, not the project ID.
The billing account email and RTDN push account email have separate purposes;
they may refer to the same account if it has both sets of permissions.

Configure Google Play Real-time Developer Notifications (RTDN) to publish to a
Pub/Sub topic, then configure an authenticated push subscription to:

```text
https://api.chefu.co.za/cloudence/billing/google-play/notifications
```

Set the push OIDC token audience to the exact URL above and use the same service
account email as `GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL`. The handler verifies
the OIDC signature, audience, and verified email before processing an event.
Test the Pub/Sub push delivery before enabling purchases.

Billing stays disabled until `GOOGLE_PLAY_BILLING_ENABLED=true`; when enabled,
startup validates all required settings. Until the Google Play products,
service account, and RTDN push are configured, the Android app intentionally
hides the purchase options.

## Verification and entitlement behavior

The authenticated routes are:

- `GET /cloudence/billing/google-play/status`
- `POST /cloudence/billing/google-play/verify` with `productId` and
  `purchaseToken`

The API retrieves subscription state and expiry from Google Play, checks the
purchase product, acknowledges unacknowledged purchases, and binds token hashes
to one Cloudence account. Raw purchase tokens are not stored. RTDN refreshes
renewal, cancellation, expiration, and revocation state. Uploads read the
subscription entitlement inside the same Firestore transaction as quota
enforcement, so a client cannot grant itself more storage. Expired or revoked
subscriptions return to the 2 GiB free allowance; existing files are retained,
but uploads are blocked until usage is back under the free limit.

The mobile app requires a new Android development/release build because
`expo-iap` is a native module. Test purchase, restore, renewal, cancellation,
and refund behavior using Play internal testing tracks and license testers
before production rollout.
