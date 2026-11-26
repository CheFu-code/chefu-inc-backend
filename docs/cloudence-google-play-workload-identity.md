# Google Play billing through Fly.io workload identity

The backend gets a short-lived JWT from the Fly Machine's `/.fly/api` socket,
exchanges it with Google Security Token Service (STS), then impersonates the
billing service account with the Android Publisher scope. Google's library
caches expiring access tokens and refreshes them automatically. No service
account private key or downloaded credential file is used for Play billing.

RTDN push authentication continues to use Google's signed OIDC tokens and
`GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL`. This change does not migrate Firebase
Admin credentials or other services' authentication.

## 1. Read your Fly identity

If billing is not configured yet, keep `GOOGLE_PLAY_BILLING_ENABLED=false` while
deploying the keyless code and completing setup. With billing enabled, missing
WIF settings deliberately prevent startup. Do not deploy over active billing
until the new trust and environment values are ready.

After deploying this code with billing disabled, run from your workstation:

```sh
fly ssh console --app chefu-inc-backend -C "node scripts/print-fly-workload-identity.mjs"
```

This prints only issuer, organization ID/name and app ID/name; it never prints
the identity JWT. Use those values below. The helper decodes claims for setup
only; Google verifies token signatures and claims during real authentication.

## 2. Create Google's trust relationship

Run the following in Google Cloud Shell while signed in to the intended project.
Replace the three Fly placeholders with the values from step 1. Use your existing
service account email if it already has Play Console billing permissions. The
project number below is Google's **project number**, not the service account's
unique ID shown on its Details page.

```sh
PROJECT_ID=chefu-technologies
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
FLY_ORG_SLUG=REPLACE_WITH_org_name
FLY_ORG_ID=REPLACE_WITH_org_id
FLY_APP_ID=REPLACE_WITH_app_id
SERVICE_ACCOUNT_EMAIL=cloudence-rtdn-push@chefu-technologies.iam.gserviceaccount.com
POOL_ID=cloudence-fly
PROVIDER_ID=fly
WIF_AUDIENCE="//iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_ID/providers/$PROVIDER_ID"

gcloud services enable iam.googleapis.com cloudresourcemanager.googleapis.com sts.googleapis.com iamcredentials.googleapis.com androidpublisher.googleapis.com --project="$PROJECT_ID"

gcloud iam workload-identity-pools create "$POOL_ID" \
  --project="$PROJECT_ID" --location=global --display-name="Cloudence Fly billing"

gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" \
  --issuer-uri="https://oidc.fly.io/$FLY_ORG_SLUG" \
  --allowed-audiences="$WIF_AUDIENCE" \
  --attribute-mapping="google.subject=assertion.sub,attribute.fly_app_id=assertion.app_id,attribute.fly_org_id=assertion.org_id" \
  --attribute-condition="assertion.org_id=='$FLY_ORG_ID' && assertion.app_id=='$FLY_APP_ID'"

gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT_EMAIL" \
  --project="$PROJECT_ID" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_ID/attribute.fly_app_id/$FLY_APP_ID"

printf 'GOOGLE_PLAY_WIF_AUDIENCE=%s\nGOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL=%s\n' "$WIF_AUDIENCE" "$SERVICE_ACCOUNT_EMAIL"
```

This trust is restricted to the exact Fly organization and app IDs, so unrelated
Fly apps cannot impersonate the billing account. Keep the pool dedicated to
this app; adding other providers to the pool changes its trust boundary.
If a pool or provider already exists, inspect it and update its configuration
instead of recreating it. Allow time for IAM changes to propagate.

In Play Console, invite `SERVICE_ACCOUNT_EMAIL` under **Users and permissions**,
grant it access to Cloudence, and enable both billing permissions listed in the
[billing setup](cloudence-google-play-billing.md). Google Cloud IAM roles alone
do not grant Play Console access. RTDN Pub/Sub permissions remain necessary.

## 3. Configure Fly and enable billing

In the Fly backend's configuration, set:

```text
GOOGLE_PLAY_WIF_AUDIENCE=<the full value printed above>
GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL=cloudence-rtdn-push@chefu-technologies.iam.gserviceaccount.com
GOOGLE_PLAY_PACKAGE_NAME=za.co.chefu.cloudence
GOOGLE_PLAY_RTDN_AUDIENCE=https://api.chefu.co.za/cloudence/billing/google-play/notifications
GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL=cloudence-rtdn-push@chefu-technologies.iam.gserviceaccount.com
GOOGLE_PLAY_BILLING_ENABLED=true
```

Apply the settings together after trust is ready. `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`
is ignored by the new code and can be removed from Fly secrets. If an old private
key was created, revoke it in Google Cloud only after confirming no other
workloads depend on it. Do not remove Firebase credentials as part of this change.

## 4. Verify the deployment

Use a Play internal test purchase to exercise both subscription verification
and acknowledgement. Test restore and a real renewal/cancellation notification.
The billing status endpoint reports configuration readiness; it does **not**
prove that the Fly-to-Google trust, Play permissions or products are working.
Pub/Sub's test notification checks push authentication but does not exercise
the Publisher API credential exchange.

Local development does not have Fly's socket. Keep billing disabled locally,
or run integration verification inside the Fly Machine; do not substitute a
static JWT or private-key fallback. Automated tests mock the identity exchange
and use local sockets without contacting Google or production.

References:

- [Fly OIDC and local token API](https://docs.fly.io/security/openid-connect)
- [Google federation and service account impersonation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-other-providers)
- [Google Play API access and billing permissions](https://developers.google.com/android-publisher/getting_started)
