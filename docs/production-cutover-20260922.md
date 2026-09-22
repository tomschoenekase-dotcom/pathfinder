# Restricted production cutover approval — 2026-09-22

Approval is not execution. Production remains unchanged until all release-specific gates pass.

## Live preflight outcome — cutover stopped

The authorized read-only preflight at `2026-09-22T20:39:48Z` identified **110** finished migrations
and **113** public tables, ending at `20260819130000_add_normalized_personality_dimensions`.
No failed, rolled-back, or logged ledger entries, invalid indexes, or unvalidated constraints were
observed. This is a different predecessor from the approved 52-row plan, so the explicit baseline-drift
stop condition fired before the backup or any live write. Production services were not drained.

The captured evidence is retained outside Git at
`C:\Users\tomsc\Downloads\PathFinder-backups\cutover-2026-09-22T20-39-48-224Z-ba0961ad\live-preflight.json`,
SHA-256 `9f1658d584dd9b0aa7f4fe481d1623007e74ad109d237c97a693581bc44d3cde`.
Offline comparison found 140 unapplied source migrations, including two earlier rebranding files.
One historical weekly-digest checksum differs from current source; prior reconciliation evidence
does not substitute for verifying the actual fresh state. There is no completed fresh backup or
110-to-250 rehearsal yet. Revised baseline/recovery review and owner approval are required before
resuming the production cutover; local source and staging validation may continue independently.

## Owner authorization

Tom approved at `2026-09-22T20:21:17Z`:

> I approve the reviewed PathFinder V2 production cutover plan for Supabase project zpacmfkomonxeqdiadtz, including only the exact production writes and stop conditions stated in that plan.

The immutable reviewed plan is retained outside the repository at
`C:\Users\tomsc\MachineWorkspaces\torchiko\20260922-client-final-mile\proof\PRODUCTION-CUTOVER-PLAN.md`.
SHA-256: `210bac2872449ad19af4b3de65d473520e5d99177c77bfadf92b573d4be9e7ac`.
The exact owner-message record is beside it in `OWNER-APPROVAL-20260922T202117Z.md`.

## Scope and admission

Only Supabase project `zpacmfkomonxeqdiadtz` and the existing three production Railway application
services in project `8621111a-4ac8-4d88-9566-4627c8a02059`, environment
`ad140532-61bb-4355-a7e3-ebb2a54d743f`, are covered. A production label alone proves nothing.

The selected application revision must first pass full CI and be admitted at that exact revision
across staging web, dashboard, and workers. Corrections after a failed gate require a new immutable
candidate and repeat the same CI/staging checks. No different commit may be substituted at promotion.

Before any production database write, identify the current live ledger, create and verify a fresh
PostgreSQL 17 logical backup, and rehearse its public application schema in a distinct disposable
PostgreSQL 17/vector 0.8.0 database. The expected historical predecessor is 52 finished migrations
through `20260809150000_add_evaluation_persistence`. Unexpected ledger state, failed or rolled-back
entries, backup failure, or data/integrity mismatch stops the cutover.

The approved roll-forward contains only the exact pending repository migrations through
`20260918190000_add_agent_routines`: 250 finished ledger rows and 267 public tables. The QR delivery
change itself adds no migrations. Prior archive-based proof is not a fresh production recovery point.

The three existing application services are drained only after preconditions pass. Their original
replica counts are retained, Redis is preserved, the live ledger is checked again, and post-upgrade
integrity and business-table preservation are verified before promotion. Branded origins are
`https://app.torchiko.com` and `https://guide.torchiko.com`; DNS and certificates must work before
application-generated links switch. Admin remains within the dashboard origin.

All background/provider execution flags remain explicitly false on the first production boot.
The plan authorizes no seed, reset, restore over production, arbitrary data edit, customer email,
billing activation, or provider/background activation. Any migration or integrity failure keeps
applications drained for assessment; there is no automatic restore or unverified app rollback.

## Status at approval

Candidate `80d4892a0570766e3352b69f65088133dc7e7027` failed CI run `35776744689` at lint.
Staging still served `a1d8b557d74d221419a842fba1435984584fd366`. The source repair replaces the
unchecked compiled QR encoder with its typed upstream source, preserving module output, and must
repeat all release gates. This document records no production migration or successful deployment.
