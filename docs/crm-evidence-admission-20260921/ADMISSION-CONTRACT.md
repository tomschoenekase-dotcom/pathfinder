# Bounded native source admission

## Owners and authority

The existing `ProspectSourceEvidence` owner retains two append-only record kinds:

- `CRM_NATIVE_SOURCE_CAPTURE_V1`: attributed foreground official-page bytes, explicit native/import identity, quotation locators, genuine observation/retrieval dates, hashes and source producer.
- `CRM_NATIVE_SOURCE_SELECTION_V1`: one capture ID, a bounded subset of its factual claim IDs, an explicit public-route claim ID or null, task purpose/hypothesis and the preceding selection ID.

Both use the existing exact component-storage envelope. Its SHA-256 binds the original JSON string inside JSONB, avoiding accidental float/text normalization. Every capture ID also derives from its canonical payload hash. The source owner already forbids updates/deletes through its append-only middleware. This change does not add a parallel source/review database, new approval state or migration. The original immutable draft/review SQL protections are unchanged.

`stageNativeSourceCapture` is a trusted, server-local source-writer entrypoint, not an HTTP action. It accepts already-captured evidence only after the original catalog integrity check and current native/import-identity check. It never fetches URLs or opens a caller-selected path. The foreground acceptance helper uses one fixed, retained genuine capture; it is not a production crawler. Human-source authenticity and semantic entailment are not established by a hash or this adapter.

The existing authenticated native-admin action and guarded local fixture action gain only `admitEvidence`. HTTP accepts existing IDs and attributed task direction, not raw capture bytes, URLs to fetch, file paths, verified flags, source-fact prose, approval or sending flags. The local recorder is the existing explicitly synthetic SYSTEM actor. Authenticated operator authority is not inferred from the supplied evidence.

## Capture contract

The exact `torchiko.native-source-capture/1` schema binds native organization/venue IDs, one existing import-record ID/hash, source workbook/raw-row hashes and sheet/row locator. It admits one to three retained HTML pages and at most twelve explicit claims, with compressed JSON at most 400 KB and each decompressed page at most 600 KB. UTF-8 capture bytes and their SHA-256 remain available in the original native source record. The browser projection exposes bounded quotes, dates, URLs and hashes, not the compressed raw data.

Each page must name the exact native venue. The designated identity page must quote its exact city and region. A related page must identify that location or directly link the named identity page; domain equality alone is insufficient. This is conservative identity/locator validation with attributed source association, not an authenticated website-ownership oracle.

Each claim refers to a retained page, its explicit evidence kind/key, exact quotation and start/end code-point indices in normalized source text. Source values must occur in the selected quote, except for explicitly checked official-site and captured-form URLs. Script/style/head/noscript content is excluded from the normalized text. Other page text remains inert data. A contact form's embedded success template does not constitute a sent message or completed action.

Only source evidence kinds supported by the existing Gate are accepted. A task hypothesis cannot relabel itself as an independently verified source or relationship fact. Public email and contact-form routes are distinct; neither establishes deliverability, consent, named mailbox operator or purchasing authority. Named decision-maker research and automatic correspondence admission are not part of this slice.

## Task selection and freshness

An admission chooses at most eight body claim IDs from one capture. The original Research Gate also evaluates the identity/site and general understanding needed for this cold, review-only task, and the explicitly selected route. Optional volatile facts not selected for the message do not trigger research merely because they exist in the capture. Selecting an expired exhibit or stale route introduces the original Gate hold.

Other native captures cannot silently replace a stale selected observation with a fresher retrieval date. Contradictory current values for a used factual key remain inputs to the original Gate and require human reconciliation; the newest result does not win automatically. A published form and an email are alternative route kinds, not contradictory email values. Conflict resolution, source retraction and multi-capture composition are deliberately not implemented here.

Selections are serialized with current native snapshot and expected selection-head checks. Exact action retries are idempotent, including a retry whose already-applied request carries its old snapshot hash. A repeated unchanged current selection is also zero-write. Changed selections append a new source record, strict audit entry and native activity. A concurrent new selection with an obsolete expected head cannot overwrite the winner.

## Original component flow

The private bridge now resolves either the historical pilot catalog or the selected native catalog. Native admission feeds the same Research Gate, the narrowly extended `composer.assemble(..., native_catalog=...)`, original WLT packet and real Approved Language owner. Native prospects retain their actual IDs; their Composer `pilot_id` is null rather than an invented pilot alias. The default five-pilot assembly remains unchanged.

No original Composer validator, meaning checker, language rule or filesystem guard is replaced or monkeypatched. Its file-bundle `prepare`, `verify_preparation`, `validate` and `export_review` APIs are unchanged. Native component preparation stays in the existing exact-byte native evidence owner; later drafts and assessments use the delivered native lifecycle, not a fake on-disk Composer bundle.

The same native meaning binding covers selected source snapshots, code/library/runtime identities, exact recipient/form route and subject/body. The UI now also exposes native raw-page SHA-256, source observation/retrieval dates and the quoted locator beside each factual source. New source/selection context invalidates applicable old preparations, drafts and meaning assessments without modifying retained history. A missing/currently held Gate decision prevents new preparation.

The existing read acknowledgment remains independent of meaning review: a read-reviewed draft can still have a BLOCKED claim assessment. `REVIEWED_NO_SEND` is not semantic approval or send authority. Acceptance of this feature requires an applicable attributed meaning assessment as well as the read acknowledgment. Approved reusable language remains a separate owner; zero approved entries stay genuinely empty.

## Local-only first-slice limits

Only the retained loopback CRM is enabled. Evidence preparation requires a unique native import lineage, an explicitly named/location-bound official capture and a supported public email/form route. Nonpilot prospects with existing threads remain held for explicit relationship/route handling instead of being restarted as cold outreach. Oversized, incomplete, stale, conflicted or ambiguous inputs fail closed; the adapter does not broaden research or silently truncate history to manufacture eligibility.

No sender, live mailbox access, campaign, contact permission update, automatic writer, language approval, deployment or production credential path is added. **SEND AUTHORIZED: NO.**
