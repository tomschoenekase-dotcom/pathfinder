# Torchiko launch commercial policy

Status: implementation constraint pending owner/legal review. This document is not a contract, privacy policy, or legal advice.

## Current launch decisions

- Every customer receives a human-approved custom quote.
- Stripe Checkout uses a monthly recurring amount derived from that approved quote.
- There is no standard free trial and Checkout never supplies a trial period or trial end.
- Small and mid-sized launch customers normally receive free setup; setup is not represented as a trial, complimentary subscription, or recurring discount.
- There is no default minimum commitment. If a reviewed order later includes one, Torchiko records it separately while Stripe billing remains monthly.
- Production money movement remains disabled until the exact legal party has been formed and owner-verified.

## Enforcement boundaries

- A new Checkout is rejected unless a platform administrator supplies the approved amount, currency, monthly interval, approval reason, and quote/order reference.
- A replay of an already-created Checkout remains available under the original tenant-scoped operation key.
- Checkout omits hard-coded payment method types so Dashboard policy controls eligible dynamic methods.
- Checkout emits no trial parameters. Provider-originated legacy/trial states remain ingestible for defensive reconciliation; they are not an offer or creation path.
- `STRIPE_MODE=live` requires production, the existing live-mode approval switch, `TORCHIKO_LEGAL_ENTITY_VERIFIED=true`, and a non-empty `TORCHIKO_LEGAL_ENTITY_NAME` sourced from owner-verified records.
- Prefer a least-privilege restricted Stripe key (`rk_`) and keep keys in the deployment secret store. Never commit or log them.

## Still outside code authority

- Entity formation, EIN, banking, tax registrations and legal review.
- Exact contracting party, agreement/order terms, cancellation/refund disclosures and privacy policy.
- Stripe business verification and any live-mode enablement.
- Tax registrations and Stripe Tax configuration. Do not enable automatic tax until the applicable registrations and tax treatment have been reviewed.

The current `/privacy` route is deliberately a status notice rather than speculative policy text. Replace it only with owner- and counsel-approved content.
