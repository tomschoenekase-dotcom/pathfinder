# Acceptance evidence contract

Run `node scripts/venue-acceptance-receipt.mjs --manifest manifest.json --output ACCEPTANCE-RECEIPT.json --as-of 2026-10-25T12:00:00Z`. Output is exclusive-create; a failing receipt exits 1. It never performs hosted work.

The manifest is `{schemaVersion:1,tenantId,venueId,package,evidence}`. Evidence keys are coverage, checkPackage, import, guestLink, embeddings, guidePreview, servingRoute, visitorQa, phoneCheck; each value is `{file,sha256}`. Relative paths resolve against the manifest. Missing evidence produces NOT_READY.

Each saved evidence file is an explicit operator attestation envelope: `{schemaVersion:1,kind,tenantId,venueId,packageSha256,measuredAt,expiresAt,environment,deployedRevision,data}`. Times are UTC instants; no future or expired measurement is accepted. Hosted kinds require environment hosted and one common 40-character deployedRevision. Observations must follow the import. These attestations are not signed; the composer proves consistency, not authenticity. Preserve raw tool output inside data; adapt native output explicitly to these predicates when preparing an attestation. A generic pass:true is never accepted.

Data contracts:

- coverage: native S2 report, PASS/passed, same as-of day, no BLOCKS rows, all input hashes reread (package, ledger, coverage, sources).
- checkPackage: ready/importable true, errorCount 0, errors [], guideQuality.total 0, otherWarnings without DUPLICATE_IN_PACKAGE, venueId.
- import: operationId, status APPLIED, receipt {status:APPLIED,operationId,packageSha256,tenantId,venueId}.
- guestLink: usable true, https url, venueId equal to the manifest venue (absent or different is rejected).
- embeddings: mode audit, actionableReasons [], recordsAudited a positive integer at least the package's created knowledge entries plus created places.
- guidePreview: native S4 report, exact packageSha256, CREATE_ONLY_PACKAGE_PREVIEW, default/evidence modes FULL or DIRECTORY, positive renderedChars, maxFullChars 120000, rendererTruncated false.
- servingRoute: guideStrategy default/evidence, modelKey, effectiveModelKey, workloadOverride string or null, venueScopeExceptions array of {venueId,modelKey}, deployedRevision.
- visitorQa: route guest, routeVerified true, turnsCompleted at least 10 (MIN_VISITOR_QA_TURNS), criticalFailures 0, questionSet {file,sha256 64-hex} recording the question set used (grading is not verifiable here), results matching count with distinct non-empty question text: {question,answer,completed:true,criticalFailure:false,firstTextMs>0,completionMs>=firstTextMs}.
- phoneCheck: rendered/passed true, viewport, checkedBy.

The fixture package contains one fictional guest record with an explicit unconfirmed disclosure; tests create fictional evidence in machine-workspace temporary directories. This contract reports no accuracy percentage and grants no publication authority.
Coverage is recomputed by the S2 checker against its actual bound files and compared to saved rows/bindings. No unresolved NEEDS_HUMAN or CONFLICTED row can yield a candidate, regardless of impact. UNKNOWN requires DISCLOSE with guest-visible unconfirmed wording; NONE cannot yield a candidate. Zero cited sources is accepted when the native checker permits it. UTC timestamps require a real canonical calendar instant; chronology uses numeric instants.
Fresh, bound coverage that recomputes successfully remains MEASURED when publication predicates fail. Its readinessPassed is false and failureReason explains the blocker. Missing, stale, hash-invalid or unrecomputable evidence remains NOT_MEASURED. A measured negative result still makes the receipt NOT_READY.

Guide previews are recomputed through the unchanged native production renderer for the exact package bytes and current as-of day; the complete saved native report must match. Rehashed stale dates, fabricated modes/counts/lengths and changed package content cannot pass. Missing local renderer dependencies fail closed; no hosted call is made. Renderer and coverage subprocesses have bounded execution time.

Validity windows: expiresAt may be at most 14 days after measuredAt for hosted kinds and 7 days for coverage, checkPackage and guidePreview; longer windows are NOT_MEASURED. If asOf differs from the real clock by more than 60 minutes the verdict can never be PUBLISH_CANDIDATE (replays stay reportable); the receipt records composedAt. Evidence files are hashed before parsing and parser errors are never reported.
Coverage readiness: a core category (hours-season, admission-prices, address-parking, contact) with status NOT_APPLICABLE, or a non-empty readinessFindings array in the RECOMPUTED checker result, makes coverage readinessPassed false. The shipped test fixture uses KNOWN rows with a fictional retained source for the core categories.
