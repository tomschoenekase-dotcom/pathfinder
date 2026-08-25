# Approved customer-access execution

Status: implemented and provider-dark proven locally on 2026-08-25. Live Clerk delivery remains external and owner-controlled.

## Boundary

An AI worker may prepare a member invitation only from an exact client-visible support message authored by an active organization owner. That creates immutable request evidence and a high-risk approval item; it does not contact Clerk, send email, create a user, or create membership.

After a human records `APPROVED`, a platform administrator may invoke `admin.executeApprovedCustomerInvitation` for the exact tenant, venue, request, and revision. The executor revalidates the original proposed action and human decision before committing `PROVIDER_STARTED`. Only after that durable fence may the provider adapter call Clerk.

Provider confirmation moves the request to `INVITED` with the exact provider invitation ID. Torchiko never manufactures `TenantMembership` during this operation: verified provider synchronization remains the authority after invitation acceptance.

## Failure and retry

An uncertain provider outcome moves the request to `RECONCILIATION_REQUIRED`. Retrying revalidates approval and scope, commits a new provider-start fence, and uses the provider adapter's pending-invitation lookup before any possible create. A matching pending invitation is reused. Revision drift, changed approval evidence, invalid lifecycle state, cross-tenant scope, and provider-evidence conflicts fail closed.

Reconciliation also opens a deduplicated Founder Control Room operational warning without exposing the target email. Exact provider confirmation resolves that warning in the same transaction as the retained provider evidence.

The Founder/agent approval context exposes a mobile-sized `Send approved invitation` action only for `APPROVED` requests and `Reconcile approved invitation` only for unresolved provider outcomes. The copy explicitly states that the action may send an external invitation email.

## Proof and retained gates

`pnpm test:customer-access-execution:disposable` uses a fresh loopback-only database and fake provider adapter. It proves owner-authored evidence, human approval revalidation, provider-before-I/O fencing, ambiguous-outcome recovery, idempotent provider reconciliation, exact confirmation, audit history, tenant/venue isolation, absence of local membership creation, and resource cleanup.

The rehearsal does not call Clerk or prove email delivery, invitation acceptance, webhook synchronization, hosted staging configuration, or production readiness. Live execution requires separately configured Clerk credentials, an intentional platform-admin invocation, and the normal staging/production release boundary. Agents have no execution tool; the machine surface remains preparation-only until a newer founder-approved trust policy grants more authority.
