# Stripe live activation checklist and sandbox test plan

> **Status: PLAN ONLY. Nothing in this document has been executed.**
> Every step marked **REQUIRES OWNER APPROVAL** must be approved by Tom (account owner) before anyone
> touches live Stripe, a live secret, production configuration, or a production deployment. Agents must
> not perform these steps. This checklist complements `docs/stripe-billing-operator-runbook.md` (sandbox
> procedure and configuration inventory) and respects `docs/database-incident-stop.md`: production stays
> in its incident posture, and no billing activation is authorized by that record.

## 0. Audit baseline (2026-10-02)

| Fact (from the live-account audit)                                                         | Consequence                                                                                              |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| No webhook endpoints exist in live Stripe                                                  | Live payments could not be confirmed to Torchiko; activation must create and verify an endpoint first.   |
| No customer-portal configuration exists in live Stripe                                     | `createPortal` cannot work in live mode until a dedicated configuration exists.                          |
| One live Product: "Torchiko pilot test fixture", USD 15/month, labelled not-for-live-sales | It must never be sold. Section 2 prevents accidental use; it is not a live catalog entry.                |
| All tenants have no billing account, no agreement, zero invoices                           | The client Billing page correctly shows "Your Torchiko team has not set up billing yet. Nothing is due." |

Code safeguards already in the repository (verify, do not assume, before each activation step):

- Live mode is rejected by the environment parser unless `RAILWAY_ENVIRONMENT=production`,
  `STRIPE_LIVE_MODE_ALLOWED=true`, `TORCHIKO_LEGAL_ENTITY_VERIFIED=true` and a legal entity name are set, and the
  key prefix matches the mode (`packages/billing/src/config.ts`).
- Checkout requires platform-admin-approved terms; tenant and customer come from the authenticated session and
  stored Stripe Customer, never from browser input.
- **New in this change:** a live catalog plan must carry a recorded `liveApproval` and must not be labelled
  test/fixture/sandbox/demo/not-for-sale in its key, display name, description or metadata
  (`liveSaleBlocker` in `packages/billing/src/catalog.ts`, enforced at catalog parse and again at plan lookup).

## 1. Catalog decision (REQUIRES OWNER APPROVAL)

Decisions to record in a durable approved location before any live object is created:

1. **REQUIRES OWNER APPROVAL:** the commercial plan(s): name, currency, interval, amount per interval, and
   venue-count rules (quantity = covered venues, minimum and maximum). Indicative pricing is not approval.
2. **REQUIRES OWNER APPROVAL:** whether launch sales are only platform-admin negotiated quotes (current code
   behavior: every Checkout requires a negotiated, audited quote under an approved Product) or also a fixed
   catalog Price.
3. **REQUIRES OWNER APPROVAL:** currency and tax-inclusive or tax-exclusive display. Amounts are stored and
   transmitted as integer minor units; do not enter a plan whose currency's minor-unit exponent has not been
   checked against Stripe's currency documentation (zero-decimal and three-decimal currencies, plus the
   currencies Stripe treats specially, behave differently from two-decimal currencies).
4. **REQUIRES OWNER APPROVAL:** minimum commitment term, cancellation and refund language, grace period days
   (`BILLING_GRACE_PERIOD_DAYS`) and recovery policy (`BILLING_RECOVERY_POLICY_APPROVED`).

Create the live objects only after step 1 is approved:

- **REQUIRES OWNER APPROVAL:** in the live Dashboard, create a **new** Product with a customer-facing name
  that contains none of the words test, fixture, sandbox, demo, or "not for live sales". Create its recurring
  Price. Do not use "Copy to live mode" from the sandbox, and do not reuse any sandbox identifier
  (`prod_V6sNP0kNT5NLzM`, `price_1U6ectQE9I6mJqyJAHAY3akc`).
- **REQUIRES OWNER APPROVAL:** add the new Product/Price ids to `STRIPE_CATALOG_JSON` as a `providerMode: "live"`
  plan with `newSalesEnabled: true` and a `liveApproval` object (`approvedAt`, `approvalReference`). Without
  `liveApproval`, or with fixture wording, the server refuses to parse the catalog.

## 2. Preventing accidental use of the USD 15 fixture (REQUIRES OWNER APPROVAL for each live action)

- Never add its Product or Price ids to `STRIPE_CATALOG_JSON` in live mode. The code refuses a live plan with
  fixture labelling regardless, but the ids should not be present.
- **REQUIRES OWNER APPROVAL:** archive the fixture Price, then archive the fixture Product in live mode (Stripe
  archives rather than deletes). Archiving stops new Checkout use. Confirm no live subscription references it
  first (the audit shows zero invoices and no agreements, so none is expected).
- Keep the fixture's labelling ("not-for-live-sales") until archived. Do not rename it to look sellable.
- Add a pre-release check: list live Products and Prices and confirm every active one appears in the approved
  catalog record and none contains fixture wording. Record the result in the release ledger.

## 3. Webhook endpoint and events (REQUIRES OWNER APPROVAL)

Endpoint: `https://app.torchiko.com/api/webhooks/stripe` (route `apps/dashboard/app/api/webhooks/stripe/route.ts`).

1. **REQUIRES OWNER APPROVAL:** create the live endpoint in the Dashboard (Developers, Webhooks). Pin the API
   version to `2026-07-29.dahlia` (the route rejects any other version with 400).
2. **REQUIRES OWNER APPROVAL:** subscribe only to the events the code supports
   (`packages/billing/src/webhook-events.ts`):
   `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `customer.created`, `customer.updated`,
   `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`,
   `customer.subscription.paused`, `customer.subscription.resumed`, `customer.subscription.trial_will_end`,
   `invoice.created`, `invoice.finalized`, `invoice.finalization_failed`, `invoice.paid`,
   `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.updated`, `invoice.voided`,
   `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.processing`,
   `payment_intent.requires_action`, `charge.dispute.created`, `refund.created`, `refund.updated`,
   `refund.failed`.
3. **REQUIRES OWNER APPROVAL:** store the endpoint's `whsec_...` only in the encrypted environment store as
   `STRIPE_WEBHOOK_SECRET`. Never paste it into source, chat, tickets or logs.
4. Behavior to confirm in sandbox first (section 7): signature required (401 otherwise), durable receipt per
   Stripe event id (duplicates return OK without re-applying), stale events recorded as ignored, events whose
   customer or subscription does not map to exactly one tenant are quarantined, and failures return 503 so
   Stripe retries.

## 4. Customer Portal configuration (REQUIRES OWNER APPROVAL)

Create a dedicated live configuration (not the account default) and record its id as
`STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID`:

- Enable: payment method update, invoice history, customer billing-information update.
- Disable until separately approved and tested: plan switching, quantity changes, self-service cancellation
  (cancellation is routed through the audited Torchiko cancellation request, which also records a reason).
- Set approved Terms and Privacy links and the support contact. If final documents do not exist, leave the Portal
  disabled (`STRIPE_CUSTOMER_PORTAL_ENABLED=false`) rather than publishing placeholder links.
- Set the fallback return URL to the approved dashboard origin (`https://app.torchiko.com/payment`).

## 5. Tax decision (REQUIRES OWNER APPROVAL)

- **REQUIRES OWNER APPROVAL:** decide, with qualified tax advice, whether Stripe Tax is used, which jurisdictions
  Torchiko is registered in, and whether displayed prices are tax-inclusive. The current client copy states the
  price is "before any applicable tax"; change it if the decision differs.
- If Stripe Tax is chosen: enable it, set the product tax code on the approved Product, collect the business
  address on Checkout, and add the corresponding Checkout parameters in code behind review. Do not enable Stripe
  Tax in the Dashboard alone and assume Checkout will use it.
- Record the legal entity name and verification that populate `TORCHIKO_LEGAL_ENTITY_NAME` and
  `TORCHIKO_LEGAL_ENTITY_VERIFIED`.

## 6. Environment variables (REQUIRES OWNER APPROVAL to set in production)

Set only in Torchiko's approved encrypted store, never as `NEXT_PUBLIC_`. Every gate defaults to off. Names are
those defined in `packages/billing/src/config.ts`.

| Variable                                   | Live value / rule                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `STRIPE_MODE`                              | `live` (only in the production environment)                                                    |
| `STRIPE_LIVE_MODE_ALLOWED`                 | `true` only at the moment of approved activation                                               |
| `TORCHIKO_LEGAL_ENTITY_VERIFIED` / `_NAME` | `true` / the verified legal entity name                                                        |
| `STRIPE_SECRET_KEY`                        | Restricted live key (`rk_live_...`) with the least permissions Checkout, Portal and reads need |
| `STRIPE_WEBHOOK_SECRET`                    | The live endpoint secret from section 3                                                        |
| `STRIPE_ACCOUNT_NAMESPACE`                 | A stable live namespace, distinct from `torchiko-test`                                         |
| `STRIPE_CATALOG_JSON`                      | Approved live catalog (section 1), no fixture ids                                              |
| `STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID`  | Live Portal configuration (section 4)                                                          |
| `BILLING_GRACE_PERIOD_DAYS`                | The approved number                                                                            |
| `DASHBOARD_URL`                            | `https://app.torchiko.com`                                                                     |

Enable gates one at a time, in this order, each as its own approved change with verification between steps:
`STRIPE_WEBHOOK_PROCESSING_ENABLED`, `STRIPE_BILLING_UI_ENABLED` (plus tenant flag `billing-ui-v1`),
`STRIPE_CUSTOMER_PORTAL_ENABLED` (`billing-portal-v1`), `STRIPE_CHECKOUT_ENABLED` (`billing-checkout-v1`),
`STRIPE_RECONCILIATION_ENABLED`, then `STRIPE_CANCELLATION_ENABLED` (`billing-cancellation-v1`).
`BILLING_ENTITLEMENT_ENFORCEMENT_ENABLED` stays off until the recovery policy is approved and a live smoke test
has passed.

A misconfigured environment is surfaced to client users as an explicit "We could not load your billing status"
state with retry (never as "no subscription" or "paid"), and logged as
`billing.client_state.configuration_error` for operators.

## 7. Sandbox test plan (no approval needed beyond sandbox access; follow https://docs.stripe.com/billing/testing)

Run only against the Torchiko sandbox with `rk_test_`/`sk_test_` keys and the sandbox catalog in
`docs/stripe-billing-sandbox-catalog.json`. Confirm the Dashboard shows Sandbox before every action.

1. **Local webhook plumbing.** Use the Stripe CLI listener forwarding to `/api/webhooks/stripe`; use the CLI's
   own `whsec_` secret. Send a request with a missing or wrong signature and expect 401.
2. **Happy path.** Create a negotiated Checkout as platform admin for a non-production tenant. Pay with
   `4242 4242 4242 4242`, any future expiry and CVC. Expect: attempt completes, subscription event applies,
   Billing page moves to "Your subscription is active" with a last-confirmed time.
3. **Declined payment.** Pay with `4000 0000 0000 0341` (attaches but fails on charge) or `4000 0000 0000 9995`
   (insufficient funds). Expect the page to show the past-due or grace state with an owner-only
   "Update payment details" action; a manager sees "Contact Torchiko" only.
4. **3D Secure.** `4000 0025 0000 3155` (authentication required). Expect checkout to complete only after
   authentication and no access granted from the return URL alone.
5. **Test clocks.** Create the customer with a test clock. Advance past the first renewal to confirm the renewal
   invoice and `invoice.paid`; advance past a failed renewal to confirm `invoice.payment_failed`, past-due, and
   that the grace end date is set once and is not extended by later retries or updates.
6. **Duplicate and out-of-order delivery.** Replay the same event id from the Dashboard or CLI (`stripe events
resend`); expect `duplicate` and no second projection. Deliver an older event after a newer one and expect it
   recorded as ignored. Deliver `checkout.session.expired` after `completed` for the same attempt and confirm the
   attempt is not downgraded.
7. **Wrong-tenant mapping.** Send an event whose metadata names tenant B while the Customer or Subscription id
   belongs to tenant A; expect quarantine plus an operational alert, and no change to either tenant.
8. **Portal.** Open the sandbox Portal as an owner; update the payment method; confirm plan switching,
   quantity changes and self-cancel are not offered; confirm a manager and staff cannot create a Portal session.
9. **Cancellation.** Request cancellation as an owner; expect cancel-at-period-end in Stripe, the "will end at the
   close of this period" state, and unchanged access until period end.
10. **Fixture guard.** With `STRIPE_MODE=live` against a local, non-secret, parse-only check (no Stripe call), confirm
    a catalog containing the fixture wording or lacking `liveApproval` fails to parse. This is covered by
    `packages/billing/src/catalog.test.ts`; rerun it after every catalog change.
11. **Currency.** Create sandbox Prices in a zero-decimal currency (JPY) and a three-decimal currency (KWD) and
    confirm amounts display exactly as in Stripe (formatting uses the ICU exponent, not a fixed two decimals).
12. **Reconciliation.** Disable the webhook endpoint briefly, change a subscription in the Dashboard, and confirm
    the Billing page shows the confirming state or stale-warning and that reconciliation repairs it.
13. **Failure UX.** Stop the database or unset `DASHBOARD_URL` in staging only; confirm the Billing page shows the
    error state with retry and never a blank page, "no subscription", or "paid".

## 8. Live smoke-test plan (REQUIRES OWNER APPROVAL for the whole section and for each step)

Preconditions: sections 1 to 6 approved and complete, green exact-SHA CI, a verified current backup, no active
incident stop covering billing, and Tom present.

1. **REQUIRES OWNER APPROVAL:** enable `STRIPE_WEBHOOK_PROCESSING_ENABLED` only. In the Dashboard, send a signed
   test event to the live endpoint; confirm 200 and a stored receipt. Confirm an unsigned request returns 401.
2. **REQUIRES OWNER APPROVAL:** enable the billing UI for one internal tenant only (flag `billing-ui-v1`); confirm
   the Billing page renders the correct state for that tenant and the "not set up" state for all others.
3. **REQUIRES OWNER APPROVAL:** enable Portal for that tenant; open it with a stored Customer; do not change
   anything.
4. **REQUIRES OWNER APPROVAL:** one real, minimum-amount subscription on an internal tenant with a company card
   owned by Tom, explicitly authorized beforehand. Verify the activation, receipt, invoice projection and audit
   trail, then cancel at period end and refund per policy.
5. **REQUIRES OWNER APPROVAL:** only then enable Checkout for the first customer tenant. Keep entitlement
   enforcement off until the policy is signed off.

## 9. Rollback

Set the relevant environment gate to `false` (all default off), disable the live webhook endpoint in the
Dashboard, and archive any live Price created in error. Existing projections are retained; reconciliation repairs
state after re-enabling. Never delete audit or receipt rows.

## 10. Open items that block live activation

- Commercial plan, price and tax decisions (sections 1 and 5).
- Legal entity verification, Terms, Privacy, cancellation and refund language.
- Live Portal configuration and webhook endpoint (do not exist today).
- Archiving the live fixture Product and Price (section 2).
- The production incident posture in `docs/database-incident-stop.md`: billing activation is explicitly not
  authorized by any existing record.
