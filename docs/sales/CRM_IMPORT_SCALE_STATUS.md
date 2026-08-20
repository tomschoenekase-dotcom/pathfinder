# CRM import and scale correction status

Date: 2026-08-20

## Implemented in this pass

- Prospect commit execution is queued with durable import identity only. The worker reloads the approved import and human approver from Postgres, processes bounded row batches, and resumes from terminal row state after a retry or restart.
- The dashboard no longer drives commit batches. It approves once, observes Postgres progress, and may be closed without stopping commit work.
- Upload, expanded-XLSX, selected-sheet, row, column, cell, and encoded source-row limits are defined at the API boundary. The limits that can be enforced by the domain action are independently rechecked in `prospect-actions.ts`.
- Workbook values are retained as inert scalar evidence. Nested formula objects are rejected; formula-like strings are never evaluated.
- Directory and pipeline pagination use a composite `updatedAt DESC, id DESC` keyset. Pipeline results are bounded and include stage totals.
- Prospect activities have a bounded chronological pagination endpoint.
- Duplicate scanning reads organizations in 5,000-record chunks and can pass the former 20,000-record ceiling. Candidate-pair generation remains deliberately bounded and reports truncation.
- Deterministic tests exercise a synthetic 20,000-row CSV-shaped path, server limits, composite cursors, worker resume/no-progress handling, and a 20,001-organization duplicate scan.
- Raw workbooks now upload directly to private versioned object storage with a signed checksum,
  byte count, MIME type, and opaque generation. The server verifies the immutable version before
  queuing work.
- A dedicated `crm-only` worker mode runs inspection, staging, and commit while outbound provider
  workers and prospect delivery stay disabled.
- Server-owned CSV/XLSX inspection enforces raw, expanded ZIP, archive-entry, sheet, row, column,
  cell, and encoded-row limits. Oversized/malformed rows are quarantined without retaining their
  unbounded payload.
- Inspection/staging jobs and commit rows use database leases with compare-and-set ownership,
  expiry recovery, and renewal. Cancellation clears pending claims while retaining completed rows.
- Duplicate review persists explicit `LINK_EXISTING`, `UPDATE_EXISTING`, `CREATE_DISTINCT`, `SKIP`,
  `QUARANTINE`, and `NOT_DUPLICATE` decisions with reviewer, note, target IDs, and foreign keys.
- Dry-run rows are copied into an append-only report snapshot with a SHA-256 identity and an
  authenticated, streamed, formula-neutralized CSV download.

## Remaining real-workbook gates

- Rehearse the same signed-upload/import flow in authenticated staging. The PC-local MinIO/Postgres
  integration now proves immutable XLSX upload, checksum/version verification, server inspection,
  staging, and append-only report snapshot creation end to end.
- Exercise cancellation through the authenticated staging UI. Reviewed archive repair is now
  implemented with an exact plan hash, strict audit, blockers for campaign/correspondence/customer
  history, and a disposable database integration proving imported-only records are archived while
  linked existing records are preserved.
- Run a full 20,000-row object-storage pipeline in staging. The server parser already processes a
  real generated 20,000-row XLSX in about 0.4 seconds in its deterministic test. On 50,000 synthetic
  PostgreSQL organizations, trigram search returned 50 matches in 1.5 ms and composite keyset paging
  returned 100 rows in 0.23 ms using the intended indexes.
- Review the real workbook dry run and every high-confidence link/update decision with Tom.

Until the staging rehearsal and Tom's dry-run review pass, the real 16,397-row workbook remains
blocked. The architectural source-storage, browser-lifecycle, claim, report, repair, and expanded-
XLSX gaps are closed.
