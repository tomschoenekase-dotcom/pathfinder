# Retention and deletion policy architecture

PathFinder does not currently enforce deletion or anonymization. No retention duration or legal
basis has been inferred. The browser-safe registry in `@pathfinder/contracts/retention-policy`
provides the data inventory, decision keys, policy fixture schema, and fail-closed readiness gate
needed to implement an approved policy later.

A full-client, count-only disposition preview is now implemented. It counts every canonical
tenant-linked model, exposes unclassified and platform-unscoped data, and keeps external artifacts
explicitly outside the database proof. See [`retention-disposition-preview.md`](retention-disposition-preview.md).

## Decision boundary

Every retention decision records an owner/legal-approved action, duration where destructive, reason,
approver, timestamp, and policy version. Missing or partial policy always blocks execution. Fixtures
exercise the mapping contract only and are not product defaults.

## Data inventory

The inventory distinguishes account/access, approved content, history/provenance, guest
conversations, analytics/reports, AI usage/cost, client-visible support, internal support,
agent/approval evidence, intake sources, offboarding evidence/exports, and billing/commercial data.
Each entry identifies personal-data potential, export eligibility, lifecycle, and deletion boundary.

## Required implementation after policy approval

1. Persist a versioned approved policy without placing legal text in environment variables.
2. Extend the current exact database-count preview into a reviewed plan with exact external artifact
   counts and revocation requirements.
3. Require preview, approval, idempotency, and append-only execution evidence.
4. Revoke guest links, widgets, keys, scheduled jobs, and access before data disposition.
5. Export approved content/history/packages and policy-allowed support material first.
6. Enforce composite tenant/venue scope and prove cross-tenant denial.
7. Test tenant deletion fixtures, partial failure recovery, replay, and restored backups.
8. Verify behavior in isolated staging only after the database incident stop is separately lifted.

This architecture intentionally exposes no delete/anonymize endpoint, worker, queue, approval
grant, or database procedure. The read-only preview cannot accept or execute a policy.
