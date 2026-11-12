# Store checkout

The store uses NestJS, Firestore and Paystack InlineJS. See the
[hardening audit and rollout guide](store-checkout-hardening.md) for findings,
state transitions, migration, account compatibility, workers, operational alerts,
configuration, and remaining acceptance checks.

## Customer endpoints

- `POST /store/checkout/initialize`: CheFu authentication and `Idempotency-Key`
  required. Accepts the existing `{items, delivery, currency:"ZAR", termsAccepted:true}`
  contract. Prices and availability come from Firestore. Delivery costs R60,
  free from R1,000; catalog prices are tax-inclusive. One unresolved checkout per
  account prevents retries/new tabs from creating extra payable sessions.
- `POST /store/checkout/verify`: `{reference}`; checks ownership and verifies with
  Paystack. Returns `{reference,currency,amountMinor,status,orderId?}`. Unknown
  outcomes stay pending. Existing guest orders retain original-cookie verification.
- `GET /store/checkout/recover`: restores the signed-in account's active order,
  purchased items, state, totals and resumable access code.
- `GET /store/checkout/orders`: latest 20 account orders.
- `POST /store/checkout/acknowledge`: `{reference}`; explicitly clears a paid or
  failed active order so another checkout can be created.
- `POST /store/checkout/claim-legacy`: `{reference}` plus authenticated account
  and original guest cookie; links a legacy order without trusting delivery email.

Checkout responses are private/no-store. New initialization requires sign-in.
The frontend restores backend state before enabling another payment. Neither
redirects nor popup callbacks confirm a payment.

## Provider and operations

`POST /store/checkout/webhook` authenticates exact raw bytes and atomically
records a deduplicated event/job before responding. A leased worker verifies the
provider transaction independently. Paid confirmation creates a fulfillment
record/job in the same transaction. A configured idempotent delivery receiver
can consume it; otherwise staff must handle the queue.

`GET /store/admin/alerts` and `POST /store/admin/retry-job` require the existing
admin role. Refund/dispute notifications are recorded for financial review;
there is no refund execution API.

Do not release uncertain reservations solely on elapsed time. Local expiry
does not prevent a later charge. Do not retry an uncertain initialization POST.
The detailed guide describes escalation and late-success inventory handling.

## Checks

Backend: `npm run test:checkout`, `npm run test:security`, `npm run typecheck`,
`npm run build`. Frontend: `npm run test:checkout`, `npm run typecheck`, and ESLint
on the cart and checkout libraries.

Browser integration: start company-app at `http://127.0.0.1:3015` with
`NEXT_PUBLIC_CHECKOUT_ENABLED=true` and
`NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4015`, then run backend
`npm run test:checkout:browser`. It starts an isolated Nest API on 4015 and uses
headless Edge on Windows; override `STORE_TEST_BROWSER_PATH` for another installed
Chromium browser. All gateway outcomes in this test are fixtures, not real charges.

Migration: `npm run migrate:store` previews changes; `npm run migrate:store --
--apply` applies the additive migration. Read the rollout guide before deployment.
