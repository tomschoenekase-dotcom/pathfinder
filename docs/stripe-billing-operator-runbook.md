# Torchiko Stripe billing operator runbook

> **Migration instruction status: STAGING-ONLY AUTHORIZED — PRODUCTION COMMANDS REMAIN STOPPED.**

**Packet date:** 2026-08-20
**Permitted mode for this handoff:** Stripe sandbox/test mode only
**Production posture:** keep every production billing gate disabled

This runbook separates code-verifiable work from operator-only Stripe, business, legal, and deployment decisions. Completing or staging the repository implementation does not create a live billing system. Do not enter a live secret, create a live Product/Price, register a production webhook, deploy to production, charge a real card, or enable live billing while following the sandbox procedure.

## Safety rules

- Confirm the Stripe Dashboard displays **Sandbox** or **Test mode** before every provider action.
- Use only a least-privilege `rk_test_...` where supported (or a short-lived sandbox CLI `sk_test_...`), sandbox `price_...`/`prod_...`, and the test endpoint's `whsec_...`.
- Never paste a secret into source, Markdown, tickets, screenshots, logs, shell history, or browser-visible variables.
- Store deployment secrets only in Torchiko's approved encrypted environment store.
- Treat Stripe CLI and Dashboard webhook secrets as different secrets even when they forward to the same local path.
- Keep billing UI, Checkout, Portal, webhooks, reconciliation, entitlement enforcement, and live-mode gates off until each relevant checklist is complete.
- Do not use indicative pricing as approved pricing. Use a clearly labeled sandbox fixture.
- Do not mark a manual invoice or external payment as a Stripe payment.
- Do not allow an agent to approve its own proposal or directly grant, extend, or activate a billing exception. Agents may create exact, idempotent billing proposals through `billing:propose`; a current human platform-admin approval plus explicit execution is always required.

## Responsibility map

| Item                 | Code can provide                                    | Tom/operator must decide or perform                                                                                    |
| -------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Domain/schema/policy | Models, ownership constraints, projections, tests   | Approve commercial semantics and retention policy.                                                                     |
| Stripe API           | Pinned client and test gateway                      | Own Stripe account, verification, keys, catalog, and endpoint configuration.                                           |
| Pricing              | Environment-safe internal catalog                   | Approve production amounts, currencies, intervals, venue-count rules, and negotiated-price policy.                     |
| Minimum term         | Metadata and Portal enforcement gate                | Approve contract term and customer-facing process.                                                                     |
| Legal/tax            | Places for links/configuration                      | Approve legal entity, Terms, Privacy, agreement, cancellation/refund language, and tax approach with qualified advice. |
| Notifications        | Operational events and approved channel integration | Approve recipients, copy, severity, and transactional delivery.                                                        |
| Rollout              | Default-off feature gates                           | Approve and audit each environment/tenant activation.                                                                  |
| Live transaction     | Kill switches and projection                        | Create live catalog/endpoint and authorize the first transaction only after all blockers close.                        |

## Preflight: repository and version

Run from the repository root. These commands do not require Stripe credentials:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm verify:tenant-registry
pnpm verify:tenant-procedures
pnpm verify:public-surfaces
pnpm verify:client-bundles
pnpm build
git status --short
```

Also run the migration against the repository's disposable database workflow before any shared environment:

```powershell
pnpm db:migrate:disposable
```

The installed `stripe-node` 22.5.0 accepts the pinned API version `2026-07-29.dahlia`. On any dependency upgrade, inspect the SDK declaration/changelog and verify `Stripe.DEFAULT_API_VERSION`. If a future SDK does not support the configured version, do not silence the type mismatch or force the string through a cast. Upgrade deliberately, rerun every gate, and keep the webhook endpoint version aligned with the SDK.

Record all command results in the implementation ledger/final report, including skipped commands and why.

## Configuration inventory

Use the exact environment and feature-flag names defined by `packages/config`; do not create deployment-only aliases. Every environment gate below defaults off:

| Variable                                  | Authority                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| `STRIPE_BILLING_UI_ENABLED`               | Allows billing UI/API visibility; it does not authorize provider mutations.   |
| `STRIPE_CHECKOUT_ENABLED`                 | Allows server-side Checkout Session creation.                                 |
| `STRIPE_CUSTOMER_PORTAL_ENABLED`          | Allows server-side Portal Session creation.                                   |
| `STRIPE_WEBHOOK_PROCESSING_ENABLED`       | Allows verified Stripe events to be applied.                                  |
| `STRIPE_RECONCILIATION_ENABLED`           | Allows scheduled/on-demand provider reconciliation.                           |
| `BILLING_ENTITLEMENT_ENFORCEMENT_ENABLED` | Allows billing policy to suspend/restore paid entitlements.                   |
| `STRIPE_LIVE_MODE_ALLOWED`                | Additional explicit authority for live mode; remains `false` for this packet. |

Tenant pilot admission is separately controlled by `billing-ui-v1`, `billing-checkout-v1`, `billing-portal-v1`, and `billing-entitlement-enforcement-v1`. Both the applicable environment gate and tenant flag must pass.

Server-only Stripe configuration is:

| Variable                                  | Value/rule                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`                       | Sandbox `sk_test_...` only for this runbook; encrypted secret store.             |
| `STRIPE_WEBHOOK_SECRET`                   | Secret for the exact CLI listener or Dashboard endpoint; encrypted secret store. |
| `STRIPE_MODE`                             | Explicit test/sandbox mode for this packet; never inferred only from an ID.      |
| `STRIPE_ACCOUNT_NAMESPACE`                | Stable provider-account namespace used in uniqueness and ownership keys.         |
| `STRIPE_CATALOG_JSON`                     | Bounded server-owned internal-plan to environment Price mapping.                 |
| `STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID` | Dedicated sandbox Portal configuration; required only when Portal is enabled.    |
| `BILLING_GRACE_PERIOD_DAYS`               | Approved, explicit grace duration; not an unexplained code constant.             |
| `STRIPE_CANCELLATION_ENABLED`             | Enables the server cancellation action; default off and still tenant-gated.      |
| `DASHBOARD_URL`                           | Approved application origin used to build Checkout/Portal return URLs.           |

The intended API version is `2026-07-29.dahlia` after installed SDK support is verified. It is centralized in `packages/billing`, not accepted from environment or browser input. The tenant router is `packages/api/src/routers/billing.ts`; platform-admin operations are in `packages/api/src/routers/admin/billing.ts`; the webhook is `apps/dashboard/app/api/webhooks/stripe/route.ts`; and worker reconciliation is `apps/workers/src/processors/billing-reconciliation.ts`.

The repository's environment parser should reject invalid combinations. Production must reject a test key, test fixture catalog, missing live approval gate, or test webhook secret. No Stripe secret or catalog containing provider IDs should use a `NEXT_PUBLIC_` name.

## Operator decisions required before sandbox setup

Record decisions in an approved durable location; do not leave them only in chat:

- sandbox currency and clearly labeled fixture amount;
- initial billing interval;
- whether quantity means covered venues and its min/max;
- immediate payment methods allowed at launch;
- grace-period duration and suspension/recovery policy;
- Portal capabilities to test (payment method, invoice history, plan change, quantity, cancellation);
- whether cancellation is unavailable during minimum commitment or routed to support;
- operational event recipients and severity;
- customer support URL/email used by Checkout and Portal;
- a non-production tenant and venue set containing no real customer data.

If any decision is missing, use an explicitly test-only fixture and keep the related UI/action disabled.

## Create the sandbox catalog (operator-only)

1. Sign in to the Stripe Dashboard and switch to a sandbox/test environment.
2. Create a Product named clearly, for example `Torchiko Pilot Test — Not for live use`.
3. Create one recurring sandbox Price with the approved test currency, amount, and interval.
4. Do not create a live Product or use **Copy to live mode**.
5. Record the sandbox Product and Price IDs in the approved server-only test catalog mapping under an internal key such as `torchiko_pilot_test`.
6. Confirm there is no live mapping for that fixture key.
7. Mark the test plan available for new sandbox sales; keep every unapproved or deprecated plan unavailable.
8. Verify the client catalog response exposes the approved name, amount, currency, interval, and venue rules but not arbitrary or alternate Price IDs.

The sandbox fixture created on 2026-08-20 is recorded in `docs/stripe-billing-sandbox-catalog.json`. Its Product is `prod_V6sNP0kNT5NLzM` and its reusable $15/month sandbox Price is `price_1U6ectQE9I6mJqyJAHAY3akc`. These identifiers are not secrets, but they belong only to the Torchiko sandbox account. Paste the file's compact JSON value into `STRIPE_CATALOG_JSON` only in an approved sandbox or staging secret/configuration store. Do not reuse either identifier in live mode.

Do not manufacture numbered Products or dozens of speculative prices. Use the reusable sandbox Price to exercise a genuine per-venue quantity. For a customer-specific negotiated total, use the platform-admin negotiated Checkout action: it creates an inline recurring Price under the same sandbox Product, requires a reason and agreement reference, uses quantity one, and is strictly audited. Customer users cannot choose or submit that amount.

For eventual production, create new live Products/Prices only after pricing and legal approval. Existing subscriptions must remain linked to their historical Price; deprecating a plan removes it from new sales rather than rewriting those subscriptions.

## Configure the sandbox Customer Portal (operator-only)

1. Create a dedicated sandbox Portal configuration rather than relying on the account default.
2. Set Torchiko test branding and an unmistakable sandbox headline.
3. Add only approved Terms and Privacy links. If final documents do not exist, leave Portal disabled rather than publishing misleading links.
4. Enable payment-method update and invoice history only if those are part of the test.
5. Keep plan switching and quantity changes off until allowed Price transitions, proration policy, and venue coverage behavior are approved and tested.
6. Choose cancellation behavior deliberately. The Stripe configuration supports immediate or end-of-period cancellation but does not enforce a Torchiko minimum commitment.
7. Record the sandbox Portal configuration ID in server-only configuration.
8. Verify the application creates sessions only for the authenticated tenant's stored Customer and only with configured return origins.

The restrictive sandbox Portal configuration created on 2026-08-20 is `bpc_1U6empQE9I6mJqyJG1jJaIPy`. It allows invoice history, payment-method updates, and basic customer billing-information updates. It disables plan switching, quantity changes, and self-service cancellation. Its fallback return URL is `https://app.staging.torchiko.com/settings`. Record this ID as `STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID` only in sandbox/staging configuration; it is not a live configuration.

Portal limitations matter: multi-product, usage-based, send-invoice, unsupported-payment-method, or scheduled-update subscriptions can have restricted modification behavior. A Portal plan change during a trial ends the trial immediately. Test the exact launch configuration.

## Configure the sandbox webhook (operator-only)

### Local development with Stripe CLI

Install the current Stripe CLI using Stripe's official instructions. Authenticate only to the intended sandbox, then run:

```powershell
stripe listen --events checkout.session.completed,checkout.session.expired,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,customer.created,customer.updated,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.subscription.paused,customer.subscription.resumed,customer.subscription.trial_will_end,invoice.created,invoice.finalized,invoice.finalization_failed,invoice.paid,invoice.payment_failed,invoice.payment_action_required,invoice.updated,invoice.voided,payment_intent.processing,payment_intent.succeeded,payment_intent.payment_failed,payment_intent.requires_action,charge.dispute.created,refund.created,refund.updated,refund.failed --forward-to http://localhost:3001/api/webhooks/stripe
```

Use the exact route and port implemented by the dashboard application if they differ. Store the `whsec_...` printed by `stripe listen` only in the local server environment. Do not use the Dashboard endpoint secret for CLI-forwarded events.

### Shared sandbox/staging endpoint

1. Confirm the URL is the reviewed public webhook route over HTTPS.
2. Create a test event destination in Stripe Workbench for **Your account**, not connected accounts.
3. Select the endpoint API version `2026-07-29.dahlia` only after SDK support is verified.
4. Subscribe only to the implemented allowlist above.
5. Store its unique test `whsec_...` in the staging secret store.
6. Keep production/live endpoint creation out of scope.
7. Enable webhook processing only after raw-body/signature and durable-receipt tests pass.

The route must receive the original bytes. If a proxy, framework middleware, or hosting layer parses or rewrites JSON, signature verification fails. Never log the body to diagnose this.

## Sandbox verification matrix

Use three layers. Routine CI remains credential-free; Stripe CLI exercises the signed public boundary; real sandbox Checkout/Portal/test clocks prove provider behavior.

### Layer 1: deterministic repository tests

Run the targeted billing tests named by the implementation plus the full repository gates. Required evidence includes:

- tenant ownership and multi-venue commercial coverage;
- multiple legitimate agreements;
- every billing-to-entitlement state, grace, paid-through, and override expiry;
- unauthorized and cross-tenant Checkout/Portal/admin rejection;
- arbitrary Price, Customer, tenant, amount, quantity, and return URL rejection;
- Checkout idempotency and duplicate-active prevention;
- redirect/query parameters never grant access;
- raw-body signature verification and missing-secret failure;
- duplicate/out-of-order events, quarantine, and retry safety;
- dropped-event/stale-state reconciliation and repeated-run idempotency;
- feature gates at UI, API, webhook, worker, scheduler, and enforcement layers;
- admin/client UI states, keyboard/focus/labels, contrast, and responsive layouts;
- client bundle contains no secret or internal provider error.

### Layer 2: Stripe CLI boundary checks

With the local listener active, trigger supported sandbox events, for example:

```powershell
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
stripe trigger invoice.paid
stripe trigger invoice.payment_failed
stripe trigger charge.dispute.created
stripe trigger refund.created
```

CLI triggers use predefined fixtures and can emit several related events. They prove signature/routing/application coverage, not the full business lifecycle. Confirm:

- one durable receipt per event ID;
- duplicate resend causes no second transition or notification;
- unknown fixture objects quarantine safely rather than attaching to a tenant;
- no secret, raw payload, card field, or full provider error reaches logs/audit;
- invalid signature and missing webhook secret fail closed.

Use the Dashboard **Resend** action or `stripe events resend` to exercise duplicates. For intentional processing failures, verify non-2xx retry behavior, then restore the handler and confirm idempotent recovery.

### Layer 3: real sandbox lifecycle

1. Create a synthetic tenant with one venue and an authorized `OWNER`.
2. Admit only that tenant through the pilot flag; keep production gates off.
3. Start Checkout from the client billing page.
4. Confirm the Session uses the tenant Customer, approved Price/quantity, safe URLs, and both Session and Subscription correlation metadata.
5. Complete payment with Stripe's `4242 4242 4242 4242` test card, any future expiry, any three-digit CVC, and a test postal code.
6. Observe the success page remain `Payment being confirmed` until local webhook/reconciliation state confirms it.
7. Verify agreement, invoice, entitlement, event, audit, and reconciliation projections for the correct tenant/venues.
8. Start Portal, update a payment method, view invoice history, and exercise only enabled plan/cancellation operations.
9. Cancel at period end and verify `cancel_at_period_end`, paid-through access, final deletion/end transition, and no venue/data deletion.
10. Retry an abandoned/expired Checkout and confirm no duplicate Customer or active subscription.
11. Test a second tenant and prove no ID, invoice, link, event, or entitlement crosses scope.

If asynchronous payment methods will not launch, keep them disabled. If they will launch, test completed/processing, async success, and async failure before staging approval.

## Test clocks

Use a fresh sandbox Customer attached to a test clock; do not attach a real or shared support fixture. Test clocks allow forward-only lifecycle simulation and emit sandbox Billing events.

Required scenarios:

1. trial/pilot end and first successful payment;
2. one normal renewal;
3. renewal failure, configured Stripe retries, local grace start, near-expiry warning, suspension, and later recovery;
4. plan change and proration behavior if enabled;
5. end-of-period cancellation;
6. complimentary/manual override expiration through Torchiko's own clock-controlled tests.

Test-clock list caveat: broad list-all APIs can omit clock-generated objects. Query by Customer, Subscription, or test-clock parent. Advances are generally limited to two shortest subscription intervals at a time. End/delete the simulation after evidence is captured; this removes its sandbox objects but affects no live data.

## Reconciliation verification

1. Process a known sandbox subscription and record the healthy projection.
2. Simulate a dropped webhook by pausing event application or withholding one fixture event.
3. Change provider state in the sandbox.
4. Run the bounded on-demand reconciliation as platform admin.
5. Confirm the same fold repairs local agreement/invoice state, updates health, emits at most one deduplicated drift event, and writes strict repair audit.
6. Run it again and confirm no duplicate effects.
7. Present an unknown sandbox Customer/Subscription and confirm it is surfaced but not adopted.
8. Test invalid/missing test credentials and confirm sanitized health/operational output.

Scheduled reconciliation remains disabled until worker registration and execution gates, bounded selection, retry/backoff, and staging provider credentials have all been proved.

## Manual, pilot, and complimentary verification

As a platform admin, using only synthetic tenants:

- create a manual-invoice agreement with source/reference and due policy;
- create a complimentary and pilot period with explicit expiration;
- record a negotiated plan/amount reference;
- create a temporary entitlement override with reason and expiry;
- transition a pilot/manual tenant to a Stripe Checkout attempt;
- expire each arrangement and verify automatic policy recalculation;
- prove client labels show the actual source and admin-only notes stay private;
- prove a tenant owner, manager, public user, and agent cannot create or extend these records;
- force strict audit failure and confirm the mutation fails rather than becoming unaudited.

## UI and accessibility review

Review both desktop and a narrow mobile viewport.

Admin billing view must show tenant/venues, mode/source, plan, safe provider links, subscription and entitlement state, dates, commitment, invoice/failure history, reconciliation health, overrides, timeline, permitted actions, and recovery guidance.

Client billing view must show plan, covered venues, amount/interval when applicable, status in text and not color alone, next billing/paid-through date, failure/recovery action, Checkout, Portal when allowed, invoice links, and support route. It must not show internal notes, raw errors, audit details, or other tenants.

Exercise loading, empty, pending, success, failure, expired Checkout, past-due/grace, canceled, manual, complimentary, and reconciliation-warning states. Verify keyboard order, visible focus, dialog/alert semantics, screen-reader labels, link purpose, contrast, zoom, touch target size, and no horizontal overflow.

The repository's `pnpm test:billing-browser` gate runs these surfaces in real Chromium at desktop and Pixel 7 dimensions, including axe color-contrast checks, keyboard activation, add-on-interest feedback, the cancellation-reason dialog, and horizontal-overflow checks. It does not replace an authenticated sandbox Checkout/Portal round trip.

## Operational-event review

Confirm stable deduplication and severity policy:

- informational: Checkout awaiting completion and meaningful activation;
- warning: payment failure, past due, cancellation ending, grace/override near expiry, recoverable drift;
- error/critical as policy dictates: signature/processing failure, unknown ownership, persistent drift, dispute/chargeback, unsafe production configuration.

Do not send high-priority alerts for every successful routine renewal. External alert delivery remains behind the repository's existing explicit delivery gates and approved transactional channel.

## Staging admission checklist

All items are required before enabling a synthetic staging pilot:

Current 2026-08-20 evidence: the guarded 133rd migration and staging web/dashboard/worker deployments succeeded; the sandbox webhook is pinned and receiving signed events; unsigned requests fail closed; card is the only enabled sandbox payment method. The intended synthetic tenant is admitted. A hosted $25/month Checkout produced an active subscription and paid invoice, Stripe retried two initially out-of-order invoice events successfully, the client/admin projections and restrictive Portal were verified, and on-demand reconciliation reports `current`. Recurring worker scheduling, deployed test-clock renewal/failure/grace, cancellation of the new subscription, refund, and dispute evidence remain outstanding. See `docs/stripe-billing-staging-status-2026-08-20.md`.

- [x] SDK/API/webhook versions match and are documented.
- [x] Disposable migration and rollback/recovery rehearsal pass.
- [x] Full typecheck, lint, unit, integration, build, security, and browser gates pass.
- [x] Sandbox Product/Price and restrictive Portal configuration are recorded.
- [x] Separate staging test provider credential and `whsec_...` exist in the encrypted store.
- [x] Public webhook route and raw-body signature proof pass.
- [ ] Checkout, Portal, renewal, failure, cancellation, dispute/refund, and reconciliation evidence pass.
- [x] Cross-tenant and multi-venue tests pass.
- [x] Operator events and strict audit are reviewed for the successful Checkout/payment/reconciliation path.
- [ ] Legal/customer-facing links are approved for any visible surface.
- [x] Only the intended synthetic tenant is asserted as allowlisted by this handoff.
- [x] Seven-day grace/recovery policy is explicit; entitlement enforcement is enabled only for the synthetic staging tenant.
- [x] Live mode remains disallowed.
- [x] Kill-switch and rollback procedure is documented and repository-tested.

## Production blockers and eventual activation

The following are operator-only and block the first live payment, even if code is mergeable with billing disabled:

1. Create or confirm the Stripe business account.
2. Complete business identity and bank verification.
3. Confirm legal entity, business name/address, statement/support contact, and support route.
4. Finalize pricing, currencies, intervals, venue-count packaging, negotiated-price policy, and minimum commitment.
5. Finalize Terms, Privacy Policy, customer agreement/order form, cancellation/refund language, and tax approach with qualified advisers.
6. Review customer communications, dunning/Smart Retry settings, and grace-policy interaction.
7. Create approved live Products/Prices separately and record only live mappings.
8. Create a dedicated live Portal configuration.
9. Configure a separate live webhook and secret at the pinned API version.
10. Repeat staging-grade lifecycle, security, accessibility, event, and reconciliation review against live configuration without charging until explicitly authorized.
11. Obtain explicit production billing and first-transaction approval; record strict audit.
12. Enable the smallest gated pilot, then perform one approved low-risk live transaction.
13. Reconcile it end-to-end and keep the kill switches immediately available.

No software configuration proves legal or tax compliance, and Stripe Portal configuration does not make a minimum commitment enforceable.

## Disable and rollback

### Normal kill-switch order

1. Disable new Checkout creation.
2. Disable new Portal Session creation if Portal actions are unsafe.
3. Disable billing UI visibility if customer-facing state is misleading; retain the admin recovery view where safe.
4. Disable scheduled reconciliation/provider workers if outbound calls are implicated.
5. Disable entitlement enforcement to prevent accidental customer suspension.
6. Prefer keeping verified webhook receipt active while pausing event application. If the endpoint itself must be disabled, expect Stripe retries and preserve the incident window.
7. Disable live-mode allowance last only after confirming no code path can mutate Stripe; the live gate is never a substitute for the earlier controls.

### Incident preservation

- Do not delete tenants, venues, billing accounts, agreements, attempts, invoices, or event/audit rows.
- Capture safe timestamps, IDs, deployment version, feature states, and the Stripe Event/request IDs—not raw payloads or secrets.
- Restore the last known-good application without downgrading or rewriting provider facts.
- Reconcile affected tenants in a bounded sandbox/staging rehearsal, then perform an audited repair.
- Disabling Torchiko does not cancel a Stripe subscription or refund a payment. Those are separate, explicit operator actions.

## Troubleshooting

### Checkout creates duplicate Customers or subscriptions

Disable Checkout. Confirm the tenant billing account stored the correct mode/account Customer, the checkout attempt was persisted before provider creation, the same operation idempotency key was reused, and active/pending agreement checks run inside the ownership transaction. Do not merge provider Customers automatically; reconcile and choose an audited repair.

### Success page remains pending

This can be correct. Check the local checkout attempt, event receipt, signature result, subscription/invoice projection, and reconciliation health. For asynchronous methods, inspect `payment_status` and await async success/failure. Never force access from the Session ID.

### Signature verification fails

Confirm exact raw bytes, the `Stripe-Signature` header, correct endpoint-specific secret, accurate server time, and that no proxy/middleware parsed or reserialized the body. The CLI listener secret and Dashboard endpoint secret are different. Do not set signature tolerance to zero or log the payload.

### Invoice stays draft or collection is delayed

Check every account webhook endpoint's `invoice.created` deliveries. Stripe can delay automatic finalization/collection for up to 72 hours when required endpoints do not acknowledge that event. Keep the handler bounded and return retry-appropriate responses.

### Event is quarantined

Do not attach it based only on email or metadata. Retrieve the provider Customer/Subscription in the stored mode/account namespace, compare exact stored IDs and tenant correlation, then either repair the correct mapping through an audited admin action or leave the object unknown and handle it in Stripe.

### Older state overwrites newer state

Disable event application if access is at risk. Confirm provider-created time, object version/current retrieval, projection guard, and duplicate key. Replay through the normalized reconciliation fold; do not edit projection rows by hand.

### Customer cannot modify a Portal subscription

Check the dedicated Portal configuration, allowed Products/Prices, tax behavior, minimum-term gate, and Stripe limitations. Multi-product, usage-based, send-invoice, unsupported-payment-method, scheduled-update, and some trial states restrict Portal modifications.

### Payment failed but subscription looks active

Do not rely on `active` alone. Inspect invoice/PaymentIntent projection and whether the payment method is asynchronous. Apply Torchiko's documented grace/manual-review policy and retrieve current objects through reconciliation.

### Reconciliation authentication fails

Keep the provider worker disabled, confirm the environment uses a test key with the expected account/mode, rotate the test credential through the approved secret store if needed, and verify logs/events contain no key or provider body. Re-enable only after a bounded on-demand check passes.

### Entitlements are wrong

Disable billing entitlement enforcement. Inspect the commercial agreement, billing policy result, paid-through/grace timestamps, override reason/expiry, tenant `planTier`, plan capabilities, and venue/tenant override precedence. Fix the domain projection or policy and replay; do not add scattered UI checks.

## Evidence to retain

Retain sanitized, durable evidence for:

- repository commit/worktree identity and migration checksum;
- SDK and API version;
- environment/feature-gate states without secret values;
- sandbox Product/Price and Portal configuration IDs;
- webhook endpoint ID/version and subscribed event names, not its secret;
- synthetic Checkout, Customer, Subscription, Invoice, Event, and test-clock IDs;
- test commands and exact pass/fail/skip outcomes;
- screenshots of responsive/accessibility states with synthetic data;
- strict audit IDs and reconciliation results;
- operator decisions and approvals;
- confirmation that no live product, charge, credential, webhook, deployment, merge, push, or unrelated state changed.

## Official Stripe references

- Stripe Billing testing: <https://docs.stripe.com/billing/testing>
- Test clocks: <https://docs.stripe.com/billing/testing/test-clocks>
- Test-clock API caveats: <https://docs.stripe.com/billing/testing/test-clocks/api-advanced-usage>
- Stripe CLI: <https://docs.stripe.com/stripe-cli/use-cli>
- CLI event triggers: <https://docs.stripe.com/stripe-cli/triggers>
- Checkout subscriptions: <https://docs.stripe.com/billing/subscriptions/build-subscriptions>
- Checkout fulfillment: <https://docs.stripe.com/checkout/fulfillment>
- Customer Portal: <https://docs.stripe.com/customer-management>
- Portal configuration: <https://docs.stripe.com/customer-management/configure-portal>
- Subscription lifecycle: <https://docs.stripe.com/billing/subscriptions/overview>
- Subscription webhooks: <https://docs.stripe.com/billing/subscriptions/webhooks>
- Webhooks: <https://docs.stripe.com/webhooks>
- Webhook signatures: <https://docs.stripe.com/webhooks/signature>
- Undelivered events: <https://docs.stripe.com/webhooks/process-undelivered-events>
- Idempotent requests: <https://docs.stripe.com/api/idempotent_requests>
- API versioning: <https://docs.stripe.com/api/versioning>
- Event catalog: <https://docs.stripe.com/api/events/types>
