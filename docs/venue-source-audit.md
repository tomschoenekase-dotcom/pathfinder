# Retained-source integrity audit

`scripts/venue-source-audit.mjs` audits explicitly named local retained files. It never fetches a URL, extracts text, repairs content, edits a ledger, or authorizes publication. All checked-in examples are fictional.

```powershell
node scripts/venue-source-audit.mjs --ledger C:/task/ledger.json --sources-dir C:/task/sources --as-of 2026-10-25 --output C:/task/reports/audit-001.json
```

The output parent must already exist. A report is created exclusively: an existing file, directory or symlink is a collision, including on a rerun. Output inside the retained-source root, aliases of source inputs, and symlink/junction output ancestors are refused. Choose a new report filename to rerun. `--sources` is an alias for `--sources-dir`; specifying both is an error. Exit codes are 0 for a passing integrity/freshness audit, 1 for recorded audit findings, and 2 for invocation, unreadable/malformed JSON input or output errors. Findings still produce a report; invocation errors write JSON to stderr without a success claim.

## Explicit audit ledger extension

The existing coverage checker only requires unique `sources[].sourceId` values. The following is a **new audit format**, not a retrofit of the coverage schema or a claim about old fetch receipts:

```json
{
  "schemaVersion": 1,
  "sources": [
    {
      "sourceId": "S001",
      "observedAt": "2026-10-24T12:00:00Z",
      "recheckBy": "2026-10-30",
      "raw": { "file": "official-page.html", "sha256": "<64 lowercase hex characters>" },
      "text": { "file": "S001.txt", "sha256": "<64 lowercase hex characters>" },
      "stale": false,
      "needsRecheck": false
    }
  ]
}
```

At least one source and at least one explicit `raw` or `text` target per source are required. Each target contains exactly `file` and `sha256`. Files are relative to `--sources-dir`, using `/` separators. Each source ID must be portable, nonempty and match `[A-Za-z0-9][A-Za-z0-9_-]*`. Case-fold ID collisions and Windows device IDs are findings. Absolute, UNC, device, alternate-data-stream and traversal paths are refused. Canonical paths must stay inside the retained-source root, including through symlinks/junctions. Multiple targets may not alias the same canonical path or physical file, including hardlinks.

The auditor never assumes `<sourceId>.txt` exists and never guesses what an unlabeled hash means. Source-ID-only ledgers, missing hashes, and ambiguous legacy declarations such as top-level `sha256`, `hashTarget`, `rawSha256` or `textSha256` produce integrity findings. Top-level and source keys are restricted to the documented fields: unsupported fields (including alternative freshness flags, nested freshness structures or expiry dates) produce integrity findings rather than silently passing. Keep other metadata in its existing owner document.

Raw HTML/PDF bytes and retained extracted-text bytes have independent hashes. Both declarations, when present, are checked independently. A text-only source can pass the byte audit for that declared file; the report makes no raw-source provenance claim. Even when both hashes match, their extraction relationship, omitted content, fidelity, officialness and factual meaning remain unverified. No source has been freshly observed merely because the audit was rerun. Coverage source spans remain governed by the existing coverage checker.

## Freshness and dates

`--as-of` is an explicit real `YYYY-MM-DD` date. `observedAt` and `recheckBy` accept real dates or canonical UTC instants (`YYYY-MM-DDTHH:mm:ssZ` or `.sssZ`). Offset timestamps and normalized invalid dates are refused. Audit time is the inclusive end of the as-of day in UTC, so an observation at noon on that day is not future. A date-only deadline equal to as-of is current through that day; an instant deadline earlier within that day has expired for this audit. A deadline preceding its observation is invalid.

Malformed, missing and future observations, malformed deadlines/flags, overdue deadlines, `stale: true`, and `needsRecheck: true` fail freshness. Missing `recheckBy` produces `NOT_VERIFIED`: no age threshold or renewal is inferred. False flags alone do not prove freshness. `PASS` means only the declared dates and recheck conditions pass these deterministic comparisons; the auditor does not confirm that observation declarations are truthful or that website content remains current.

## Library and report contract

```js
import { auditSources } from './scripts/venue-source-audit.mjs'
const report = await auditSources({ ledgerPath, sourcesDir, asOf: '2026-10-25' })
```

The library is read-only and returns a deterministic report. Unreadable roots/ledger files, malformed JSON and invalid invocation dates throw. Source-level problems become findings. `main(argv, io)` exposes the CLI and returns its exit code.

- `schemaVersion: 1`, `tool: 'venue-source-audit'`, `asOf`.
- `passed`: true only when `integrity.status` and `freshness.status` are both `PASS`.
- `integrity: {status: 'PASS'|'FAIL', errors: string[]}` checks declarations, identities, containment, existence and bytes.
- `freshness: {status: 'PASS'|'FAIL'|'NOT_VERIFIED', errors: string[]}` checks declared observations/recheck conditions.
- `semantic` and `extraction` each contain `status: 'NOT_VERIFIED'`, regardless of `passed`.
- `bindings.ledger: {file, sha256}` binds the exact input JSON bytes and canonical absolute path. `bindings.sourcesRoot` binds the canonical retained-source directory. `bindings.sources[]: {sourceId, target: 'raw'|'text', file, sha256}` binds each successfully read retained file's actual bytes. Mismatched files bind the actual hash, not the declaration. Unavailable/escaped/aliased targets are not read or bound.
- `sources[]: {index, sourceId, targets[]}` records each declaration's target and `PASS`/`FAIL`, with expected/actual hashes when read. `errors` combines integrity and freshness findings.

No generation timestamp or implicit current clock enters the result. Moving inputs changes absolute path bindings. Reports bind a completed observation, not a live lock against concurrent filesystem changes. Consumers must compare/re-audit the exact input bytes before relying on a saved report. `passed` is not permission to import, publish, fetch, send, or claim factual/extraction verification.

Focused verification (set TEMP/TMP for this process to the allocated external task tmp directory): `node --test scripts/venue-source-audit.test.mjs`. Tests retain their small fictional scratch directories for inspection.

Coverage resolves the same declared `text.file` used by this auditor. A zero-byte raw or text file produces `SOURCE_EMPTY`, even if its declared hash correctly matches the empty bytes. The target remains FAIL and its actual hash is retained. Each `sources[]` row includes `passed`, true only when all declared targets and that source's identity, integrity and freshness checks pass. Authoring batches require every cited coverage source to have a passing audited text target with the same canonical file and actual SHA-256; a raw-only target cannot attest to coverage text. See [venue-coverage.md](venue-coverage.md) for checker version bindings and current tooling defaults.
