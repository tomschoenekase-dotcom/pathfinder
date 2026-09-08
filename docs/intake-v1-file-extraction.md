# V1 uploaded-file extraction

Submitting a V1 revision creates one canonical processing dispatch for each supported, verified upload. A worker discovers pending dispatches from PostgreSQL and sends only their opaque IDs to the dedicated BullMQ queue. Revisions and retries retain their exact source hashes.

## Formats and review

- PDF: at most 10 MiB, 200 pages, 500,000 Unicode code points and a 15-second parser budget. No OCR.
- UTF-8 plain text, Markdown, CSV and JSON: at most 2 MiB.
- Other formats and files above these limits remain explicitly held for another supported review path.

Extraction records evidence. A successful receipt still needs an accepted human extraction review before the original V1 upload member can contribute to a package candidate. The canonical reviewed-proposal adapter verifies the review and clarification evidence. Package draft creation, approval, application and publication remain separate operations.

## Isolated worker configuration

The new worker is disabled by default. Its explicit flag is `INTAKE_V1_FILE_EXTRACTION_WORKERS_ENABLED=true`. Run it in its own process with outbound providers, general worker schedulers and other isolated worker modes disabled. Startup rejects incompatible modes rather than silently leaving the file queue unserved.

The isolated mode requires Redis, the canonical database and the existing versioned-upload storage configuration. Supply credentials through the deployment's existing secret configuration. The worker does not require a model provider or malware scanner: authoritative upload verification happens before V1 admission.

The dedicated recovery scheduler scans PostgreSQL once per minute. Each dispatch has a 120-second database lease and at most three attempts; Redis delivery is a wake-up mechanism, not the source of lifecycle authority. The owner read uses the same file flag to show when processing is waiting to be enabled.

## Identity and recovery

The immutable member hash binds the clean upload-verification receipt, including storage generation/version, byte count and SHA-256. The database validates the file source kind, bounded extractor profile and separate scoped file receipt relationship; website receipts cannot be substituted.

Claiming serializes the source upload. Preflight checks the exact active lease before storage access. The canonical receipt transaction checks that lease again before writing, so a stale worker cannot record a new receipt after its lease expires.

An exact retained source receipt can be reused across V1 revisions without fetching bytes again. Executions keep a fixed operation ID and actor across retries. Failure handling recovers a committed receipt before exhausting the last attempt. A malformed sibling does not prevent a successful file from reaching an explicitly acknowledged partial package draft.

## Retained local proof

See `docs/evidence/intake-v1-file-extraction-local-2026-09-08.json` for the measured migration, database journey, focused tests and rendered owner status evidence. The connected database test uses an injected local byte transport. A separate registered-runtime proof is retained in `docs/evidence/intake-v1-file-runtime-local-2026-09-08.json`: actual disposable Redis/BullMQ recovery, worker, database lifecycle and extractor, with only exact file bytes substituted. These proofs do not establish hosted storage, production enablement or publication.
