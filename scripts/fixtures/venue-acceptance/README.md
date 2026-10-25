# Acceptance evidence contract

Run `node scripts/venue-acceptance-receipt.mjs --manifest manifest.json --output ACCEPTANCE-RECEIPT.json --as-of 2026-10-25T12:00:00Z`. Output is exclusive-create; a failing receipt exits 1. It never performs hosted work.

The manifest is `{schemaVersion:1,tenantId,venueId,package,evidence}`. Evidence keys are coverage, checkPackage, import, guestLink, embeddings, guidePreview, servingRoute, visitorQa, phoneCheck; each value is `{file,sha256}`. Relative paths resolve against the manifest. Missing evidence produces NOT_READY.

Each saved evidence file is an explicit operator attestation envelope: `{schemaVersion:1,kind,tenantId,venueId,packageSha256,measuredAt,expiresAt,environment,deployedRevision,data}`. Times are UTC instants; no future or expired measurement is accepted. Hosted kinds require environment hosted and one common 40-character deployedRevision. Observations must follow the import. These attestations are not signed; the composer proves consistency, not authenticity. Preserve raw tool output inside data; adapt native output explicitly to these predicates when preparing an attestation. A generic pass:true is never accepted.

Data contracts:

- coverage: native S2 report, PASS/passed, same as-of day, no BLOCKS rows, all input hashes reread (package, ledger, coverage, sources).
- checkPackage: ready/importable true, errorCount 0, errors [], guideQuality.total 0, otherWarnings without DUPLICATE_IN_PACKAGE, venueId.
- import: operationId, status APPLIED, receipt {status:APPLIED,operationId,packageSha256,tenantId,venueId}.
- guestLink: usable true, https url.
- embeddings: mode audit, actionableReasons [], recordsAudited positive integer.
- guidePreview: native S4 report, exact packageSha256, CREATE_ONLY_PACKAGE_PREVIEW, default/evidence modes FULL or DIRECTORY, positive renderedChars, maxFullChars 120000, rendererTruncated false.
- servingRoute: guideStrategy default/evidence, modelKey, effectiveModelKey, workloadOverride string or null, venueScopeExceptions array of {venueId,modelKey}, deployedRevision.
- visitorQa: route guest, routeVerified true, turnsCompleted positive integer, criticalFailures 0, results matching count: {question,answer,completed:true,criticalFailure:false,firstTextMs,completionMs}.
- phoneCheck: rendered/passed true, viewport, checkedBy.

The fixture package is fictional and intentionally empty; tests create fictional evidence in machine-workspace temporary directories. This contract reports no accuracy percentage and grants no publication authority.
Coverage is recomputed by the S2 checker against its actual bound files and compared to saved rows/bindings. No unresolved NEEDS_HUMAN or CONFLICTED row can yield a candidate, regardless of impact. Zero cited sources is accepted when the native checker permits it. UTC timestamps require a real canonical calendar instant; chronology uses numeric instants.
