# Local venue coverage and recheck register

`node scripts/venue-coverage/check.mjs --package PACKAGE --ledger LEDGER --coverage COVERAGE --sources SOURCES --as-of YYYY-MM-DD --output NEW_REPORT` checks schemaVersion 3 authoring packages against explicit coverage rows. It does not fetch sources, decide factual truth, authorize publication, or change the active v4 standard.

Each cited source uses its ledger `text.file` relative to `SOURCES` when a `text` declaration exists. Unsafe or missing declared files fail; they never fall back to another file. Legacy source-ID-only ledgers still resolve `<sourceId>.txt` for standalone coverage checks. Those legacy ledgers cannot pass the retained-source auditor. Exact spans use JavaScript string offsets in the retained UTF-8 text.

Reports bind input and cited source bytes by SHA-256. `bindings.checker` identifies `check.mjs` by exact runtime-byte SHA-256 and `gitBlob` (the SHA-1 Git blob object ID after this repository's LF text normalization). `gitBlobNormalization: 'LF'` makes that normalization explicit across Windows autocrlf checkouts. This works with uncommitted checker edits and does not require Git at runtime. It is an implementation identity, not a signed attestation or a dependency-tree binding.

## Readiness findings

`passed` and `verdict` report the coverage contract check. `readinessFindings` separately identifies every enabled authored record with canonical Hours/Closed/Season, Price/Prices/Admission/Cost, Status, or Height labels that is missing from its category row. Place `hours` fields also count. A record already governed by `events` may carry its own Hours line. Disabled/inactive records and SOURCE_CONNECTION knowledge are excluded.

A contract PASS with any readiness finding is still NOT_READY for publication. The authoring batch records `READINESS_FINDING` reasons with category and record pointer; the acceptance composer recomputes these findings. Bind supported records to their governing rows while preserving the row's status. Binding does not settle an uncertainty or verify a copied fact.

## Current D3 tooling defaults

These defaults already existed in the reviewed start commit. Documenting them does not adopt the proposed v5 standard or resolve the pending owner decisions:

- `hours-season`, `admission-prices`, `address-parking`, and `contact` cannot be NOT_APPLICABLE; free admission is KNOWN.
- UNKNOWN, CONFLICTED, and NEEDS_HUMAN require BLOCKS or DISCLOSE; KNOWN cannot be BLOCKS.
- `recheckBy` is required for applicable hours, closures, prices and events, and may be at most 180 days after `observedAt`; other supplied deadlines may be at most 366 days after observation.
- Source spans contain at least 8 non-whitespace characters.
- A disclosure requires a body line containing `unconfirmed` without negating it. A title alone does not count. UNKNOWN DISCLOSE requires every cited record to disclose; CONFLICTED/NEEDS_HUMAN require at least one current disclosure home.

## Recheck register

`node scripts/venue-recheck-register.mjs --package PACKAGE --coverage COVERAGE --as-of YYYY-MM-DD --output NEW_REGISTER` writes a read-only register of authored records and their itemKeys. It preserves row statuses and uses the earliest valid governing deadline for each record. States are CURRENT, OVERDUE, NO_DEADLINE, or UNBOUND_LABELED_FACT. A deadline equal to the as-of day is current through that day. Unbound labeled facts take priority over the other states. CURRENT does not establish factual truth.

The standalone command binds package/coverage bytes and the checker version. It exits nonzero for overdue or unbound records; NO_DEADLINE remains visible without inventing a policy deadline. Output uses exclusive creation. The authoring batch also saves `RECHECK-REGISTER.json` for each successfully prepared venue and binds it in `result.json`. The register is an operator review artifact; it does not fence production records, schedule rechecks, or implement pending D1 product decisions.

Coverage reports retain the canonical source directory as `bindings.sourcesRoot`. Acceptance recomputation uses that explicit root, so nested `text.file` targets retain the same interpretation. Missing, altered, or noncanonical root bindings cannot match the recomputed report. Adding checker/root bindings invalidates older saved coverage envelopes; regenerate coverage evidence with the current checker rather than editing an old report.
