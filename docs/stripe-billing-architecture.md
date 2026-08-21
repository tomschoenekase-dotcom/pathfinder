# Torchiko Stripe billing architecture

**Packet date:** 2026-08-20
**Scope:** recurring billing foundation in Stripe sandbox/test mode
**Production posture:** disabled; this document does not assert that live billing is configured or operational

## Purpose and boundaries

Torchiko charges its own customer tenants for Torchiko services. This is a standard Stripe Billing integration, not a Stripe Connect marketplace. The design contains no connected accounts, transfers, split payments, venue payouts, or marketplace tax flow.

Stripe owns payment collection and emits provider events. Torchiko owns tenant identity, commercial agreements, billing projections, access policy, entitlements, audit evidence, and operational recovery. No request path should call Stripe synchronously merely to decide whether a user may access a Torchiko feature.

The foundation deliberately preserves early-customer flexibility. The implemented launch paths are a Stripe subscription, a manual invoice, a complimentary or pilot arrangement, or an explicit no-billing-required mode. The typed `STRIPE_INVOICE` value is reserved but no automated Stripe invoice creation/collection action is exposed until that full flow is implemented and verified. Those sources remain visibly distinct. A manual confirmation is never represented as a Stripe payment.

## Existing repository foundations

Before this packet, billing-adjacent state consisted of `Tenant.planTier` and a manually maintained `Tenant.nextPaymentDue`. The repository already provides the architectural seams the billing domain must reuse:

- Clerk-backed users, tenant memberships, and role-aware server procedures;
- composite tenant/venue relationships and tenant-isolation middleware;
- append-only `AuditLog` evidence and strict audit helpers;
- tenant and platform operational events with deduplication and bounded delivery;
- background workers and explicit scheduler/provider gates;
- server kill switches plus `TenantFeatureFlag` allowlists;
- `ProductPlanCapability`, time-bounded `ProductEntitlementOverride`, and the centralized `resolveProductEntitlement` policy;
- public-surface inventory checks, environment validation, and browser-bundle secret scans.

Billing extends these patterns. It must not create a parallel identity, authorization, alerting, audit, or entitlement system.

The integration is centralized in `packages/billing`. Tenant-facing procedures live in `packages/api/src/routers/billing.ts`, platform-admin procedures in `packages/api/src/routers/admin/billing.ts`, the signed public boundary in `apps/dashboard/app/api/webhooks/stripe/route.ts`, and scheduled repair in `apps/workers/src/processors/billing-reconciliation.ts`. UI code calls these server-owned surfaces; it does not import the Stripe SDK or interpret provider state itself.

## Sources of truth

| Concern                                 | Authoritative source                                                                 | Notes                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Tenant, membership, and venue ownership | Torchiko database                                                                    | Every billing action begins from authenticated server context.                                                                |
| Commercial terms and venue coverage     | Torchiko commercial agreement                                                        | Internal plan version, negotiated snapshot, minimum term, and covered venues remain durable even when a Stripe Price changes. |
| Provider payment facts                  | Stripe plus verified provider events                                                 | Local state is an asynchronous projection, repaired through reconciliation.                                                   |
| Receipt and processing history          | Torchiko billing event ledger                                                        | Deduplicated by provider account/mode/event ID; payload storage is bounded and sanitized.                                     |
| Current support view                    | Torchiko billing, agreement, invoice, and checkout projections                       | UI never treats a redirect query parameter as proof.                                                                          |
| Access decision                         | Torchiko billing-to-entitlement policy followed by the existing entitlement resolver | Stripe status is input to policy, not direct product authorization.                                                           |
| Manual exceptions                       | Torchiko audited records                                                             | Platform-admin only, with reason, reference, and expiration.                                                                  |

Provider IDs are namespaced by Stripe mode and account identity. A test-mode `cus_`, `sub_`, `price_`, `in_`, `pi_`, or `evt_` value must never be accepted as a live-mode identity merely because its prefix looks valid.

## Domain model and invariants

The Prisma foundation uses `BillingAccount`, `CommercialAgreement`, `CommercialAgreementVenue`, `BillingCheckoutAttempt`, `BillingInvoiceProjection`, `StripeWebhookReceipt`, `BillingEventApplication`, `BillingReconciliationRun`, and `BillingAccessOverride`. Their durable concepts are:

### Billing account

One tenant-owned `BillingAccount` carries billing contact and legal/display-name snapshots, currency, billing mode, Stripe mode/account/customer identity, local status projection, reconciliation health, safe internal references, and audit timestamps. The schema allows one billing account per tenant, while `CommercialAgreement` remains one-to-many. Stripe Customer identity is separately unique within the mode/account namespace.

Supported modes are typed, not arbitrary strings:

- `STRIPE_SUBSCRIPTION`
- `STRIPE_INVOICE` only when its full collection flow is implemented
- `MANUAL_INVOICE`
- `COMPLIMENTARY`
- `PILOT`
- `NO_BILLING_REQUIRED`

### Commercial agreement

`CommercialAgreement` records the commercial promise independently of Stripe: tenant, internal plan key and version, interval, quantity, price/currency snapshot, start and period dates, minimum commitment, cancellation intent/effective date, trial or pilot dates, negotiated reference, provider subscription/price identity when applicable, and any bounded override.

An explicit join records covered venues using composite tenant/venue ownership. This supports a simple single-venue launch while allowing a multi-venue tenant and future add-ons or multiple legitimate agreements. There is no blanket one-tenant-one-subscription uniqueness assumption.

### Checkout attempt

A durable `BillingCheckoutAttempt` is reserved before calling Stripe. It binds the authenticated tenant, billing account, agreement, approved catalog plan/version, quantity, actor, Stripe namespace, and operation key. Provider Session identity is attached after creation. Terminal states distinguish completion, expiration, cancellation, and provider failure. The operation key is also the Stripe idempotency key; safe origins are supplied from validated server configuration rather than persisted browser input.

### Billing event ledger

`StripeWebhookReceipt` is durable before application. It stores mode/account namespace, event ID/type and API version, primary object IDs, provider creation time, receipt time, processing status, attempt count, payload hash, sanitized bounded evidence, resolution/error category, and quarantine reason. `BillingEventApplication` stores the immutable resulting transition. Unknown or mismatched mappings are quarantined instead of being silently treated as processed.

Application is replay-safe. A duplicate event can add no second business effect. Provider time, projection version, current-object retrieval, and monotonic transition rules prevent an older delivery from overwriting newer known state. Arrival time alone is never used as the provider sequence.

### Invoice/payment projection

`BillingInvoiceProjection` keeps its Stripe/manual source, invoice identity and number, status, amounts due/paid/remaining, currency, due and payment/failure times, next retry when supplied, PaymentIntent reference where useful, a customer-safe failure summary, and Stripe-hosted invoice, document, or receipt links where appropriate. It stores no PAN, CVC, raw PaymentMethod, or full Stripe error/payload.

### Reconciliation health

Each Stripe-backed account and arrangement records reconciliation timestamps, health/drift category, and bounded diagnostic metadata. Scheduled and platform-admin on-demand reconciliation retrieve authoritative linked subscriptions and invoices, apply idempotent projection repair, and audit repairs. Unknown external objects are surfaced by verified webhook quarantine; account-wide discovery of Stripe objects that have never referenced Torchiko remains an operator Dashboard review step.

## API and SDK version

The Stripe API is pinned to `2026-07-29.dahlia`, the current official API version when this packet was implemented. Installed `stripe-node` 22.5.0 accepts this exact typed version. On any SDK upgrade, verify the SDK changelog and `Stripe.DEFAULT_API_VERSION`; do not force a newer version through a cast while compiling against older TypeScript types.

The Stripe client is constructed in one server-only module. The same API version must be selected when the sandbox webhook endpoint is created. Webhook Event objects keep the API version used at event creation; later request headers do not reshape old events.

No secret key, webhook secret, raw event, or provider error is exposed through a browser contract. Logs contain safe internal/provider identifiers and error categories only.

## Product and price catalog

Browser code sends an internal plan key and a bounded quantity, never a Stripe Price ID or amount. The server-owned catalog maps:

- internal plan key and immutable plan version;
- display name and approved customer-facing description;
- interval, currency, unit amount snapshot, and venue-count rules;
- test Price ID and, only after a separate approval, live Price ID;
- availability for new sales, allowed plan changes, and deprecation status;
- entitlement plan tier and settings projection.

The sandbox fixture should use an unmistakable internal key such as `torchiko_pilot_test`. Indicative $15-$25 small-venue pricing is not an approved production catalog. Custom negotiated agreements record their own amount/currency/reference snapshot without modifying global plan definitions. A deprecated Price can remain linked to an existing agreement while disappearing from new Checkout choices.

### Standard, quantity-based, and negotiated pricing

Torchiko should not create a new Product for every customer. The base Torchiko venue subscription is one Stripe Product per environment. Reusable Stripe Prices are appropriate only for approved standard offers. Quantity is used only when the commercial formula is genuinely linear, such as a sandbox fixture priced per covered venue.

For a platform-admin-approved negotiated total, the server creates Checkout with inline recurring `price_data` referencing the approved catalog Product. The amount, currency, and interval come from the audited commercial action, never from a client billing request. Stripe creates an effectively archived Price for that subscription, keeping customer-specific prices out of normal catalog searches while retaining the resulting Price ID on subscription and webhook projections. The agreement stores the negotiated total, covered venues, and agreement or quote reference; strict audit records the pricing reason.

The admin action requires a bounded positive minor-unit amount, currency, interval, reason, and external agreement reference. Customer routes have no negotiated amount field. A negotiated Checkout always uses quantity `1`; venue coverage remains a Torchiko entitlement concept rather than an artificial multiplier.

The approved launch model is therefore one environment-specific Torchiko subscription Product and as many customer-specific recurring Prices as negotiated agreements require. A customer agreeing to $7, $20, $85, or $400 per month receives one quantity-1 subscription item and an invoice for that exact amount. Torchiko absorbs its processor and Billing fees; the application does not add a percentage surcharge or ambiguous fee line to the customer's invoice. Two customers with the same negotiated amount may still retain separate inline Prices so their agreement histories remain independent.

Catalog parsing fails closed if mode, currency, Price namespace, required mapping, or plan-change policy is invalid. A production process must reject fixture keys and test Price IDs.

## Checkout flow

1. An authenticated tenant `OWNER` or platform admin requests Checkout. `MANAGER` and public actors are denied.
2. Server context supplies the tenant. The server validates the internal plan, quantity, covered venues, feature gates, catalog environment, and absence of a conflicting active or pending arrangement.
3. A checkout attempt and intended agreement correlation are durably reserved. Platform-admin link creation writes strict audit evidence.
4. The centralized gateway creates or reuses the billing account's tenant-owned Stripe Customer, then creates a hosted Checkout Session with `mode=subscription`, the server-selected recurring Price, safe configured URLs, and the persisted operation ID as idempotency key.
5. Session metadata identifies the checkout attempt; `subscription_data.metadata` separately identifies the tenant/agreement for later subscription events. Metadata is a correlation aid, never sole ownership proof.
6. The browser is redirected to the returned Stripe URL. It cannot override customer, amount, Price, tenant, or return URL.
7. The success page displays a pending-confirmation state. It reads local projection state only and grants nothing from `session_id` or other query parameters. The cancellation page safely retries through a new or reusable local attempt without duplicating a Customer or active subscription.
8. Verified webhook processing and reconciliation establish the durable subscription/payment projection.

If asynchronous payment methods are enabled, `checkout.session.completed` can precede final payment. The launch catalog should either restrict payment methods to immediate methods or retain a distinct processing state and handle `checkout.session.async_payment_succeeded` and `.async_payment_failed`.

## Customer Portal

Portal Sessions are created server-side after tenant-role and feature-policy checks. The Customer ID comes only from the tenant's billing account and the return URL comes from configured approved origins. Portal Sessions are short-lived and are not persisted as reusable links.

Use a dedicated restrictive Portal configuration, not mutable account defaults. Payment-method updates and invoice history can be enabled independently. Plan switching, quantity changes, proration behavior, and cancellation mode are explicit operator decisions. Allowed replacement Prices must match the internal catalog.

Stripe Portal does not enforce Torchiko contractual minimum commitments. When an agreement is still inside its minimum term, self-service cancellation or a conflicting downgrade remains disabled and the UI routes the customer to support. End-of-period cancellation is projected first from `customer.subscription.updated` with `cancel_at_period_end=true`; final termination arrives as `customer.subscription.deleted`. Paid-through access is a Torchiko policy decision using the projected period end.

## Webhook boundary and event application

The public webhook route is intentionally unauthenticated by Clerk but authenticated by Stripe signature. It is registered in the repository public-surface manifest.

The route must:

1. fail closed when processing is disabled or the endpoint secret is absent;
2. read the exact, unparsed UTF-8 request bytes;
3. verify `Stripe-Signature` with the endpoint-specific secret and Stripe library;
4. reject missing/invalid signatures without parsing or applying the event;
5. enforce a bounded body size and sanitize every log/error;
6. durably reserve/deduplicate the event identity before effects;
7. enqueue or apply bounded work and return retry-appropriate responses.

Current event coverage for this foundation is:

- Checkout: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`;
- customer: `customer.created`, `customer.updated` where useful;
- subscription: `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`, `.trial_will_end`;
- invoice: `invoice.created`, `.finalized`, `.finalization_failed`, `.paid`, `.payment_failed`, `.payment_action_required`, `.updated`, `.voided`;
- payment detail when needed: `payment_intent.processing`, `.succeeded`, `.payment_failed`, `.requires_action`;
- attention: `charge.dispute.created`, `refund.created`, `refund.updated`, `refund.failed`.

`invoice.paid` is the primary paid transition because it also covers zero-value, credit-balance, below-minimum, and legitimately marked out-of-band invoices. `invoice.payment_succeeded` is not required for the core projection and must not cause a duplicate success effect. Likewise, dispute/refund/PaymentIntent events enrich support state; they do not bypass invoice/subscription ownership checks.

Stripe does not guarantee event order and can deliver duplicates. Missing objects are retrieved from Stripe during reconciliation. A tenant/customer/subscription mismatch becomes a quarantined event plus operational alert; it never falls back to metadata or applies to the nearest matching tenant.

`invoice.created` handling must remain fast and reliable: failed delivery can delay automatic invoice finalization and collection for up to 72 hours.

## Reconciliation

Webhook delivery and reconciliation are complementary:

- a scheduled worker selects a bounded page of active/stale Stripe arrangements;
- every worker start rechecks global, environment, and provider gates;
- current Stripe Customer, Subscription, and recent Invoice state is retrieved under the stored mode/account namespace;
- the same normalized event/projection fold performs repairs idempotently;
- unknown provider objects, stale local objects, or ownership conflicts are recorded without automatic adoption;
- persistent drift publishes a deduplicated operational event;
- platform-admin on-demand reconciliation is authorization checked, strictly audited, and bounded to the requested tenant/agreement.

Provider authentication/configuration failure updates health and emits a sanitized platform event. It does not leak a key or provider response.

## Billing-to-entitlement policy

Billing never scatters feature checks through React components or Stripe calls. One tested domain policy translates agreement mode, billing projection, dates, grace configuration, dispute/manual-review state, and a valid platform-admin override into an entitlement projection. The existing product-entitlement resolver remains the final capability gate: server kill switch, active venue override, active tenant override, then plan capability; missing configuration denies access.

The policy distinguishes at least:

| Billing condition                               | Conservative entitlement posture                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Checkout pending, subscription incomplete       | No paid entitlement solely from Checkout; preserve any separately valid pilot/manual access. |
| Trialing or active pilot                        | Time-bounded agreed plan and venue coverage.                                                 |
| Active subscription with confirmed paid invoice | Agreed plan and covered venues.                                                              |
| Past due inside configured grace                | Preserve service, show recovery, emit deduplicated warning.                                  |
| Unpaid after grace                              | Suspend paid entitlements; preserve data and recovery path.                                  |
| Cancel at period end                            | Preserve access through paid-through/current period end.                                     |
| Canceled/ended                                  | Remove paid projection after paid-through date; never delete venue/customer data.            |
| Paused                                          | Apply configured suspension policy; do not confuse with Stripe's pause-collection behavior.  |
| Disputed/manual review                          | Conservative review state; platform operator decides any immediate suspension.               |
| Manual invoice current/overdue                  | Use explicit local due/grace policy; never mark as Stripe-paid.                              |
| Complimentary/pilot                             | Time-bounded access that expires automatically.                                              |
| Admin override                                  | Requires platform-admin actor, reason, reference, expiry, and strict audit.                  |

Grace duration is configuration and an operator-owned business decision, not an unexplained constant. Grace expiry suspends capabilities but performs no destructive deletion. Agents cannot grant, extend, or approve billing access or overrides.

## Manual and early-customer arrangements

Platform-admin-only commands can create a manual invoice arrangement, a complimentary or pilot period, a negotiated commercial reference, a legitimate external-payment confirmation, a temporary entitlement override, or a transition to Stripe. Every command validates tenant and venue ownership, requires source/reason and expiration where applicable, uses optimistic/idempotent mutation semantics, and fails if strict audit cannot be written.

The client and admin UI label the source (`Manual invoice`, `Complimentary`, `Pilot`, or `Stripe`) rather than collapsing it into a generic paid badge. Internal notes and provider diagnostics are visible only to platform admins.

## Operational events and audit

Billing uses the existing tenant/platform operational-event center with stable deduplication keys. Routine renewals should not create high-priority noise. Actionable signals include Checkout awaiting completion, activation, payment failure, past due, grace or override expiry, cancellation, webhook verification/processing failure, unknown object, reconciliation drift, dispute, refund attention, and incomplete production configuration.

Strict append-only audit is required for platform-admin Checkout creation, manual/complimentary changes, overrides, internal plan changes, cancellation/suspension, reconciliation repair, billing flag changes, and any future live-mode activation. Provider payloads, secrets, full errors, card data, and sensitive customer data never enter operational metadata or audit snapshots.

## Client, CRM, and agent surfaces

The ultra-simple client dashboard exposes billing as a first-class `Payment` tab at `/payment`. The tab is computed server-side and appears only when both the environment UI kill switch and tenant pilot flag pass. Its success and cancellation routes remain inside the same client navigation. Returning from Checkout never grants access; the Payment page continues to show the webhook/reconciliation-backed projection.

Platform operators receive a bounded global Billing portfolio at `/admin/billing`, alongside each customer's detailed billing workspace. The portfolio summarizes attention, past-due, and reconciliation counts; shows exact negotiated amount, paid-through date, latest invoice and failure state; and joins a converted customer to its active `ProspectCustomerRelationship`. The CRM prospect page reciprocally displays the linked customer's billing snapshot and opens the canonical tenant billing record. Prospect correspondence does not become billing authority, and billing state does not overwrite CRM history.

Codex and Hermes use Torchiko's existing MCP credential and exact-scope boundary. The `pathfinder.read` tool can request the client-scoped `billing` resource only when the verified credential includes both `resources:read` and `billing:read`. The response is a bounded, sanitized projection of arrangements, amounts, paid-through/grace dates, recent invoices, and reconciliation health. It deliberately omits Stripe Customer/Subscription IDs, hosted payment links, internal notes, and raw event payloads.

The separate `pathfinder.propose_billing_action` tool requires `billing:propose` and exact venue scope. It can record an idempotent negotiated Checkout, grace-period, or period-end cancellation proposal, but the proposal has no provider or access authority. The exact amount, interval, venue, reference, reason, and expiry are frozen into a `BillingAgentCommand` linked one-to-one to an immutable high/critical-risk `ApprovalRequest`. A current human platform-admin approval and a second explicit execution action are required before the canonical billing service can call Stripe or create an override. Agents still cannot approve their own proposal, issue refunds, mark manual payments, grant complimentary access, activate live mode, or receive a Stripe secret key.

Customer cancellation and add-on interest are durable `BillingCustomerRequest` records. Cancellation collects a reason and requests Stripe cancellation at period end; the verified subscription webhook remains authoritative and access continues through the paid-through date. Add-on interest creates a CRM/operational follow-up signal only. It never changes price or sends an unreviewed offer automatically.

## Feature flags and environment isolation

Billing must pass all applicable layers, not merely hide a button:

- global environment gates `STRIPE_BILLING_UI_ENABLED`, `STRIPE_CHECKOUT_ENABLED`, `STRIPE_CUSTOMER_PORTAL_ENABLED`, `STRIPE_WEBHOOK_PROCESSING_ENABLED`, `STRIPE_RECONCILIATION_ENABLED`, `BILLING_ENTITLEMENT_ENFORCEMENT_ENABLED`, and `STRIPE_LIVE_MODE_ALLOWED`;
- tenant allowlist flags `billing-ui-v1`, `billing-checkout-v1`, `billing-portal-v1`, and `billing-entitlement-enforcement-v1`;
- role authorization in every procedure/route;
- worker and scheduler gates checked both at registration and execution;
- provider configuration validation and catalog-mode checks.

All production defaults are off. A live key or live Price is insufficient authority. Live mode additionally requires an explicit live-mode gate, approved catalog, separate live webhook secret, matching API version, and audited operator activation. Test fixtures are rejected by production catalog validation.

Server-only provider configuration uses `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_MODE`, `STRIPE_ACCOUNT_NAMESPACE`, `STRIPE_CATALOG_JSON`, and `STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID`. `BILLING_GRACE_PERIOD_DAYS` is the explicit access-policy input, and `DASHBOARD_URL` is the approved base used to build return URLs. None of these values are trusted from a request or duplicated into a `NEXT_PUBLIC_` variable.

## Security and privacy invariants

- Tenant, Price, amount, quantity bounds, Customer, Subscription, and redirect origins are server-owned.
- Provider objects are applied only after exact stored tenant/account/mode ownership checks.
- Secret and webhook keys exist only in the approved deployment secret store and server runtime.
- Test and live secrets, customers, prices, and webhook secrets are separate.
- Only bounded normalized fields or a payload hash are retained; raw card/payment-method data is never stored.
- Dashboard links are constructed only from validated provider IDs and mode; external links use safe `rel` behavior.
- Customer UI contracts omit internal notes, raw provider errors, other tenants, audit internals, and webhook payloads.
- Missing configuration, audit failure, ambiguous ownership, and catalog mismatch fail closed.

## Failure and rollback model

Disabling Checkout and Portal stops new customer-initiated provider mutations while retaining support visibility. Disabling entitlement enforcement prevents billing from suspending product access during an incident. Disabling reconciliation and scheduler gates stops outbound repair calls. Webhook processing should be disabled only as an incident action after acknowledging that Stripe will retry for a bounded period; preserving durable receipt while pausing application is preferred when available.

Rollback never deletes billing rows, events, invoices, agreements, tenants, or venues. Restore the last known-good application, keep production billing gates off, preserve database evidence, reconcile in sandbox/staging, and apply an audited repair. Provider-side cancellation or refund is a separate operator decision and is not implied by disabling Torchiko flags.

## Official Stripe references

- API versioning: <https://docs.stripe.com/api/versioning>
- Subscriptions: <https://docs.stripe.com/subscriptions>
- Checkout subscriptions: <https://docs.stripe.com/billing/subscriptions/build-subscriptions>
- Checkout fulfillment: <https://docs.stripe.com/checkout/fulfillment>
- Checkout Session API: <https://docs.stripe.com/api/checkout/sessions/create>
- Metadata propagation: <https://docs.stripe.com/metadata>
- Subscription lifecycle and statuses: <https://docs.stripe.com/billing/subscriptions/overview>
- Subscription webhooks: <https://docs.stripe.com/billing/subscriptions/webhooks>
- Webhook delivery/security: <https://docs.stripe.com/webhooks>
- Signature verification: <https://docs.stripe.com/webhooks/signature>
- Event types: <https://docs.stripe.com/api/events/types>
- Idempotent requests: <https://docs.stripe.com/api/idempotent_requests>
- Customer Portal: <https://docs.stripe.com/customer-management>
- Portal configuration: <https://docs.stripe.com/customer-management/configure-portal>
- Invoice lifecycle: <https://docs.stripe.com/invoicing/integration/workflow-transitions>
- Billing testing: <https://docs.stripe.com/billing/testing>
- Test clocks: <https://docs.stripe.com/billing/testing/test-clocks>
- Stripe CLI triggers: <https://docs.stripe.com/stripe-cli/triggers>
