# Customer state preservation and return-path review

Torchiko derives a versioned, read-only customer-state preservation context for internal
offboarding and exact-scope billing readers. It answers what durable venue material remains
available before a seasonal return or reactivation decision. It does not reactivate service.

## Evidence

The projection reads only durable, tenant-scoped facts:

- current tenant, billing-account, and venue availability;
- retained Place and Venue Knowledge records;
- Venue Package and deployment-manifest records;
- a retained bot-configuration record;
- the latest non-cancelled offboarding plan for each in-scope venue;
- bounded counts of revocation evidence and export artifact metadata.

Current active service takes precedence over completed historical offboarding evidence. A current
offboarding plan takes precedence over otherwise-active service. Inactive venues with operational
material are labeled `PRESERVED_STATE`; completed revocation evidence requires
`RESTORATION_REVIEW`. A venue with no operational material is labeled `LIMITED_EVIDENCE` rather
than being described as rebuild-ready.

The query caps plan history at 100 matching plans and reports `evidenceBounded` when more history
exists. Agent reads are further limited to the exact venue IDs in their verified credential.

## Policy boundary

Every projection explicitly states:

- no automatic reactivation;
- no automatic customer contact;
- retention policy unresolved;
- pause-fee policy unresolved;
- reactivation-fee policy unresolved.

The implementation creates no provider call, billing mutation, access restoration, offboarding
transition, customer message, deletion, retention timer, or fee.
