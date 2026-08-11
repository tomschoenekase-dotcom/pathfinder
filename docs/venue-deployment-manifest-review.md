# Venue Deployment Manifest v2 review

The internal platform-admin workspace exposes a read-only review route at:

`/admin/clients/{tenantId}/venues/{venueId}/deployment-manifest`

It accepts at most 250,000 characters of JSON text, verifies that the selected venue belongs to the exact tenant scope, validates the strict Venue Deployment Manifest v2 contract, and uses the canonical conversion bridge to show:

- conversion errors and warnings;
- the versioned manifest hash when validation succeeds;
- the exact `venuePackage.preview` input shape;
- the exact `venuePackage.createDraft` input shape for compatible PATCH manifests; and
- the existing lifecycle procedure names for preview, draft, approval, apply, and rollback.

The route never invokes those lifecycle procedures. It performs no create, update, approval, apply, rollback, queue, audit, or persistence operation. Invalid input is not echoed in the response, so unknown secret-bearing fields rejected by the strict contract are not reflected into review evidence.

The existing VenuePackage preview remains authoritative for database-backed duplicate detection, current base digests, and stale-content checks. Operators must resolve conversion errors before using the displayed handoff in a separately authorized workflow.
