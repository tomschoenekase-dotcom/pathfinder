# Torchiko Stripe billing staging status

**Status date:** 2026-08-20 America/Chicago (provider events occurred 2026-08-21 UTC)  
**Repository branch:** `codex/torchiko-crm-staging-reconciled-20260820`  
**Verified code commit:** `0a6fe9f` (`fix(billing): opt card-only Checkout out of Managed Payments`)  
**Verdict:** the sandbox/staging payment path is working end to end; production/live billing is not configured or authorized

## Executive status

Torchiko successfully created and collected one synthetic $25/month Stripe subscription in the `Torchiko sandbox` account. Stripe-hosted Checkout, signed webhook delivery and retry, local subscription/invoice projection, centralized entitlement evaluation, on-demand reconciliation, the client `Payment` tab, the platform billing/CRM view, and the restrictive Stripe Customer Portal were verified against the deployed staging application.

This was not a live payment. Stripe reported `livemode=false`; the card was Stripe's `4242` test Visa; no bank transfer or real card network charge occurred. Production remains fail-closed because `STRIPE_LIVE_MODE_ALLOWED=false`, no live catalog or live webhook is configured, and no production billing rollout was performed.

## Deployed sandbox payment evidence

| Evidence                        | Verified value                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| Synthetic tenant                | `org_3I9zLyO7TQ0F7PTZD3x9YM7I59U` (`TorchikoTestClient`)                                   |
| Covered venue                   | `cmt0vp1wa0004ov01fl2o876c` (`TestVenue`)                                                  |
| Internal plan                   | `torchiko_pilot_test`                                                                      |
| Stripe account                  | `acct_1U6ePbQE9I6mJqyJ` (`Torchiko sandbox`)                                               |
| Product                         | `prod_V6sNP0kNT5NLzM` (`Torchiko pilot test fixture`)                                      |
| Customer-specific sandbox Price | `price_1U6jqTQE9I6mJqyJb0EDqA0q`, $25/month, quantity 1                                    |
| Checkout attempt                | `cmt2fqhe70001pi01g5szgcou`                                                                |
| Checkout Session                | `cs_test_a14Ws8ZFyfYNCIglqj5wtXqcWIqnshp9WPx04eFTlJJmBviqmbM7psK21R`                       |
| Stripe Customer                 | `cus_V6xR9TAFjghnWO`                                                                       |
| Subscription                    | `sub_1U6juJQE9I6mJqyJU5nDHhqd`                                                             |
| Invoice                         | `in_1U6juHQE9I6mJqyJVnijqs4a`, number `5QQITSOI-0001`                                      |
| Payment result                  | `$25.00 USD`, paid, sandbox/test mode                                                      |
| Renewal / paid-through          | September 21, 2026 in Stripe UTC; September 20, 2026 in the America/Chicago client display |
| Payment method                  | Stripe test Visa ending `4242`, expiry 12/2034                                             |
| Entitlement projection          | Active for `TestVenue`                                                                     |
| Reconciliation                  | On-demand run completed; health changed from `unknown` to `current`                        |

The success redirect displayed a pending-confirmation message and did not grant access from URL parameters. Webhooks established the durable state. `invoice.finalized` and `invoice.paid` initially arrived before the subscription mapping and received retryable `503` responses. Stripe redelivered both events after the mapping existed, both returned `200 OK`, and the event ledger recorded monotonic application (`invoice.paid` was correctly ignored as stale after a newer provider projection had already established the paid state).

## Staging configuration, without secret values

Railway staging dashboard service `b2f6989e-a7bc-4ad9-8ed4-a39dd67b947f` currently has:

| Setting                                   | Staging status                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `STRIPE_MODE`                             | `test`                                                                       |
| `STRIPE_ACCOUNT_NAMESPACE`                | `torchiko-test`                                                              |
| `STRIPE_BILLING_UI_ENABLED`               | `true`                                                                       |
| `STRIPE_CHECKOUT_ENABLED`                 | `true`                                                                       |
| `STRIPE_CUSTOMER_PORTAL_ENABLED`          | `true`                                                                       |
| `STRIPE_WEBHOOK_PROCESSING_ENABLED`       | `true`                                                                       |
| `STRIPE_RECONCILIATION_ENABLED`           | `true`                                                                       |
| `BILLING_ENTITLEMENT_ENFORCEMENT_ENABLED` | `true`                                                                       |
| `STRIPE_CANCELLATION_ENABLED`             | `true`                                                                       |
| `STRIPE_LIVE_MODE_ALLOWED`                | `false`                                                                      |
| `BILLING_GRACE_PERIOD_DAYS`               | `7`                                                                          |
| `DASHBOARD_URL`                           | `https://app.staging.torchiko.com`                                           |
| `STRIPE_SECRET_KEY`                       | Configured in Railway's encrypted staging variables; value not recorded here |
| `STRIPE_WEBHOOK_SECRET`                   | Configured in Railway's encrypted staging variables; value not recorded here |
| `STRIPE_CATALOG_JSON`                     | Configured with sandbox-only IDs; full value not recorded here               |
| `STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID` | Configured with sandbox Portal configuration `bpc_1U6empQE9I6mJqyJG1jJaIPy`  |

The synthetic tenant has `billing-ui-v1`, `billing-checkout-v1`, `billing-portal-v1`, `billing-cancellation-v1`, and `billing-entitlement-enforcement-v1` enabled. No other tenant admission is asserted by this handoff.

Railway staging worker service `7c551d35-b2d4-4ab0-917f-9680ccdee86a` has test mode, a configured test provider key/catalog, reconciliation enabled, and entitlement enforcement enabled. `WORKER_SCHEDULERS_ENABLED=false`, so recurring scheduled reconciliation and scheduled grace/expiry enforcement are not running in staging. On-demand reconciliation is verified through the admin billing view. The worker does not have the webhook secret or Portal configuration ID; those are not required by its reconciliation role. Do not describe scheduled lifecycle automation as staging-verified until the global scheduler is deliberately enabled and observed.

The currently configured sandbox CLI/provider credential expires on 2026-11-19. Rotate or replace it before then. Before live activation, prefer separate least-privilege restricted keys for the dashboard and worker after validating required API permissions in sandbox.

## Verified product behavior

- The client portal exposes a feature-gated `Payment` tab with the $25/month amount, active status, covered venue, next billing/paid-through date, and paid invoice document.
- The platform billing workspace exposes the tenant, venue, mode, internal plan, safe Stripe IDs/links, subscription, invoice, entitlement, reconciliation health, recovery action, and verified event timeline.
- The Stripe Customer Portal opens for the tenant-owned Customer and shows the current $25/month subscription, test card, billing information, and invoice history.
- Portal plan switching, quantity changes, and self-service cancellation are disabled. Torchiko owns the reason-required, paid-through cancellation request flow.
- Add-on interest creates a durable CRM/operational follow-up request; it does not change price or automatically send an unapproved commercial offer.
- Agents can read a sanitized billing projection and propose an exact billing action, but a human platform-admin approval and explicit execution are required. Agents cannot approve their own proposal, grant exceptions, issue refunds, or activate live mode.
- The launch sandbox is card-only. Torchiko absorbs provider fees; the displayed customer amount is the agreed subscription amount. Tax calculation is off.

## Test and verification record

The implementation ledger contains the complete historical command record. The relevant successful gates were:

- `pnpm test`: all 25 Turbo test tasks passed. At that run this included 129 dashboard files/775 tests, 112 API files/1,180 tests, 48 worker files/385 tests, 41 web files/304 tests, and all remaining workspace suites. Environment-gated integration tests reported their skips explicitly.
- `pnpm test:scripts`: 172 runnable repository contract tests passed; one pre-existing populated-legacy-data fixture was explicitly skipped.
- `pnpm test:browser-foundation`: 218 DOM interaction/state tests passed. This is jsdom coverage, not hosted Stripe automation.
- `pnpm test:accessibility`: automated axe gates passed. Computed contrast is not available in jsdom and was separately checked in Chromium.
- `pnpm --dir apps/dashboard test:billing-browser`: 18 desktop/mobile Chromium billing cases passed, including keyboard, dialogs, overflow, axe, and computed contrast.
- Billing package tests passed before the deployed payment run, and the later provider/service regression slices passed 11/11 and 4/4 after the Checkout/idempotency corrections.
- Database operational-event regression tests passed 5/5 after tenant-scoped deduplication was corrected.
- Database, billing, contracts, API, dashboard, and affected worker typecheck/lint gates passed.
- Prisma format/generate, the fresh loopback disposable 133-migration chain, tenant registry, tenant-procedure inventory, public-surface inventory, tenant-bypass boundary, migration-manifest freeze, production build, browser-bundle secret scan, and `git diff --check` passed.
- Deployed sandbox verification passed: health `200`, unsigned webhook rejection `401`, signed fixture delivery `200`, real hosted Checkout paid, webhook retry recovery, client/admin projection, on-demand reconciliation, and Portal launch.

Final documentation-handoff rerun on 2026-08-20:

- `pnpm --dir packages/billing test`: 11 files and 47 tests passed.
- `pnpm --dir packages/billing typecheck` and `pnpm --dir packages/billing lint`: passed.
- `pnpm --dir packages/api typecheck` and `pnpm --dir packages/api lint`: passed.
- `pnpm --dir apps/dashboard test:billing-browser`: the first run had two pending-state visibility timeouts during the initial Next.js cold start while the other 16 cases passed; an immediate complete rerun passed all 18/18 cases in 28.1 seconds. No source change was needed between runs.
- Prettier check, `git diff --check`, and a documentation secret-pattern scan passed before the documentation commit.

The following lifecycle evidence remains sandbox-only or incomplete:

- The successful payment itself is sandbox-only and cannot validate settlement, payout timing, live issuer behavior, or real dispute economics.
- Test-clock renewal, renewal failure, Smart Retry/dunning, seven-day grace expiry, suspension, recovery, refund, and dispute/chargeback have deterministic code coverage but were not all run as one deployed provider lifecycle against this subscription.
- The cancellation reason UI/domain path has automated browser/unit coverage; the newly paid subscription was intentionally not canceled during payment verification.
- Recurring worker scheduling is disabled in staging, so scheduled reconciliation and time-based enforcement are not operationally observed.
- No real customer, real card, live Product/Price, live webhook, live API credential, production deployment, first live payment, refund, dispute, tax calculation, payout, merge, or push occurred.

## Code commits included in the deployed billing result

The billing foundation begins at `37b5c1d` (`feat(billing): add Stripe sandbox subscription foundation`). The post-deployment corrective chain is:

1. `c128e63` — allow pending Stripe customer linkage.
2. `7f0aaff` — bound admin billing failure logs.
3. `95b1dbd` — scope idempotency lookups by tenant.
4. `2923ca8` — use valid nested venue writes.
5. `6ba8554` — expose tenant scope on provider writes.
6. `ed0fb93` — scope operational-event deduplication by tenant.
7. `d9f8344` — reuse a matching pending Checkout.
8. `0e6ac99` — restrict Checkout to card payments.
9. `0a6fe9f` — opt card-only Checkout out of Stripe Managed Payments.

These commits are local on `codex/torchiko-crm-staging-reconciled-20260820`. This documentation handoff is committed separately after its checks. Nothing was pushed or merged by this work.

## Not configured for live mode

The following are intentionally absent or unverified and block the first live payment:

- confirmed Stripe business activation, legal entity/business address, bank account, statement descriptor, support contact, and strong Dashboard access controls;
- finalized production pricing/commitment policy and approved order-form process;
- final Terms, Privacy Policy, customer agreement, cancellation/refund language, and qualified tax determination;
- tax registrations, an approved Stripe Product tax code, Price tax behavior, and `automatic_tax`; tax remains off and must not be enabled merely because Stripe Tax is available;
- live restricted API keys and their least-privilege/IP access policies;
- a live Product and approved live standard Prices; sandbox Products and Prices cannot be reused in live mode;
- a live internal catalog containing only live IDs;
- a dedicated live Customer Portal configuration;
- a live webhook endpoint, its separate signing secret, its exact event allow-list, and matching API version;
- production values for every server-only Stripe variable and production feature flags/tenant admissions;
- enabled/observed production reconciliation scheduler and grace/expiry scheduler;
- live-mode dunning/Smart Retry, invoice emails, branding, receipt, support, and cancellation settings;
- an approved live rollout audit record and explicit first-transaction authorization.

## Exact later live-mode procedure

Do not replace test values in place or copy sandbox objects into production. Use a separate production configuration and keep all production gates off while performing steps 1–15.

1. In Stripe live mode, complete/verify the Torchiko business identity, bank/payout account, public business details, statement descriptor, support email/URL, team access, and passkey/authenticator-based MFA.
2. Finalize the production commercial policy: standard offers, negotiated-price approval, currency, billing interval, minimum commitment, grace period, refunds, cancellation, and who may execute approved agent proposals.
3. Finalize the customer-facing Terms, Privacy Policy, order form/customer agreement, refund/cancellation wording, and support route.
4. With qualified tax advice, determine where Torchiko must register and which Stripe Product tax code/tax behavior is appropriate. Record active registrations in Stripe only after registration with the relevant authority. Keep `automatic_tax` off until the registrations, origin, customer address, tax code, and tax behavior are verified.
5. Review sandbox Stripe request logs and create separate least-privilege live restricted keys for the dashboard and reconciliation worker. Add key access policies/IP restrictions where the hosting model permits. Store them only in Railway production encrypted variables; never in Git, Markdown, `NEXT_PUBLIC_` variables, logs, or screenshots.
6. Create one live Torchiko subscription Product. Create reusable live Prices only for approved standard offers. Continue using audited quantity-1 customer-specific recurring Prices for negotiated totals. Never reference `prod_V6sNP0kNT5NLzM`, `price_1U6ectQE9I6mJqyJAHAY3akc`, or `price_1U6jqTQE9I6mJqyJb0EDqA0q` in production.
7. Create a dedicated live payment-method configuration. The approved launch requirement is cards only; verify that Checkout displays only card and that Stripe Managed Payments cannot add other methods. Revisit the explicit code-level card restriction only through a reviewed change if the business later allows dynamic methods.
8. Create a dedicated restrictive live Customer Portal configuration: invoice history and payment-method updates on; plan/quantity changes and Stripe self-service cancellation off unless a later approved policy says otherwise.
9. Create a live webhook endpoint for `https://app.torchiko.com/api/webhooks/stripe` (or the final approved production origin), select **Your account**, pin the same API version supported by the deployed Stripe SDK, and subscribe to the exact documented allow-list. Store that endpoint's live `whsec_...` separately from every sandbox/CLI secret.
10. Configure Railway production with `STRIPE_MODE=live`, a new production `STRIPE_ACCOUNT_NAMESPACE`, live restricted keys, the live webhook secret, live-only catalog JSON, live Portal configuration ID, approved production `DASHBOARD_URL`, and the approved grace duration. Keep all seven billing capability gates and every tenant billing flag off; keep `STRIPE_LIVE_MODE_ALLOWED=false`.
11. Deploy the reviewed commit and migration to production with billing disabled. Run health, migration-ledger, secret-scan, unsigned-webhook rejection, and a Stripe live endpoint connectivity check that does not create a payment.
12. Run a production configuration audit: no `test` key or sandbox object ID, webhook/API versions match Stripe SDK `22.5.0`, return URLs use the production origin, secrets are server-only, and the kill switches are immediately available.
13. Enable only webhook receipt/processing and reconciliation for an internal production test tenant if the approved rehearsal requires it. Verify signed delivery, unknown-object quarantine, audit, and on-demand reconciliation without enabling customer Checkout.
14. Obtain and record explicit human approval for live billing and one low-risk first transaction. Set `STRIPE_LIVE_MODE_ALLOWED=true`, then enable the minimum environment gates and only the named internal pilot tenant flags. Do not broadly enable all tenants.
15. Create and pay one approved low-risk live subscription. Verify the Stripe payment, webhook/event ledger, invoice, paid-through projection, entitlement, Portal, CRM view, operational events, reconciliation, payout/settlement visibility, and customer receipt. Keep the subscription unless the approved test plan explicitly authorizes cancellation/refund.
16. After the first payment, leave the kill switches available, monitor webhook delivery/reconciliation/payment health, and close any mismatch before admitting another tenant. Enable scheduled reconciliation/grace enforcement only after a bounded production observation and explicit approval.

If any step fails, disable Checkout and Portal first, then entitlement enforcement and schedulers as appropriate. Preserve billing/event/audit records. Disabling Torchiko flags does not cancel or refund a Stripe subscription.

## Official references checked for this handoff

- Stripe go-live checklist: <https://docs.stripe.com/get-started/checklist/go-live>
- API keys and test/live separation: <https://docs.stripe.com/keys>
- Restricted API keys: <https://docs.stripe.com/keys/restricted-api-keys>
- Billing testing and lifecycle events: <https://docs.stripe.com/billing/testing>
- Test clocks: <https://docs.stripe.com/billing/testing/test-clocks>
- Checkout subscriptions: <https://docs.stripe.com/billing/subscriptions/build-subscriptions>
- Customer Portal: <https://docs.stripe.com/customer-management/integrate-customer-portal>
- Webhook signatures: <https://docs.stripe.com/webhooks/signature>
- API versioning: <https://docs.stripe.com/api/versioning>
- Stripe Tax setup: <https://docs.stripe.com/tax/set-up>
