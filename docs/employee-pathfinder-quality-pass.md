# Employee PathFinder quality pass

Date: 2026-08-14

## Implemented boundary

The existing premium second-layer work is treated as an employee experience, not a second public
guest surface. Access requires all of the following:

- the venue has the employee experience enabled;
- the access-link key matches;
- the requester has an authenticated account;
- the requester's active tenant owns the venue; and
- the requester has an active tenant role.

The key remains a defense-in-depth route secret. It is not the authorization boundary by itself.
The current permission model is tenant-member access to every enabled venue in that tenant; it does
not yet support assigning an employee to only one venue.

Legacy Places and Knowledge entries now support `PUBLIC` and `SECOND_LAYER` visibility. Public chat
retrieval explicitly excludes employee entries, including operational updates joined through an
employee-only Place. Employee chat includes both public and employee entries. Employee sessions are
stored with `SECOND_LAYER` scope and are visible as Employee conversations in internal chatlog
diagnostics.

Visitor analytics, enrichment, daily rollups, weekly reports, weekly digests, and client analytics
are restricted to `PUBLIC` sessions. Employee chat does not emit the browser visitor-event stream.

## Deliberate limits

- Native-core/generalized ITEM publication still has its existing PUBLIC/CLIENT/OPERATOR audience
  model. Adding an EMPLOYEE audience requires a coordinated contract and release-policy decision;
  this pass does not reinterpret existing audiences.
- Venue-specific employee assignments and multiple employee permission levels require a product
  decision and a membership/capability model. The current tenant role is intentionally the smallest
  compatible authorization boundary.
- The existing content-version database trigger predates visibility and therefore does not include
  visibility in its immutable JSON snapshots. Application audit events do record visibility changes.
  A follow-up migration should replace the trigger function and update restore parsing before
  visibility history is presented as complete.
- Website intake remains capture-only, and uploaded bytes remain quarantined. No crawler, malware
  scanner, or unsafe approval path was introduced without an approved provider and safety policy.

## Operational status

The Prisma migration in `20260814120000_add_premium_second_layer` is authored but was not executed.
No staging or production deployment, data mutation, email delivery, credential use, or external
service configuration occurred during this pass.
