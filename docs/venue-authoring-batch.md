# Local venue authoring batches

`scripts/venue-authoring-batch.mjs` runs an explicitly listed set of local venue packets. It calls the retained-source auditor, coverage checker, production guide preview and acceptance composer in that order for each venue. Every stage finishes before the next starts. A failed stage or venue does not cancel independent work. This tool performs no research, import, network call, publication or outreach.

## Invocation

```powershell
node scripts/venue-authoring-batch.mjs --manifest C:/MachineWork/fictional-batch/manifest.json --output-dir C:/MachineWork/fictional-batch/run-001 --timeout-ms 30000
```

Use the allocated external machine workspace for packets, outputs and test temporary files. The output parent must already exist; `run-001` must not exist. Every run needs a new directory. The runner never resumes or overwrites prior evidence. It accepts no command, executable, script or environment overrides from the manifest or CLI.

Exit status is `0` when every requested check passes its readiness predicates, `1` when a requested venue/check fails, and `2` for an invalid invocation or batch layout. JSON goes to stdout and a concise summary goes to stderr. A local-only subset can exit `0` while publication remains `NOT_READY`.

## Explicit manifest

```json
{
  "schemaVersion": 1,
  "asOf": "2026-10-25T12:00:00Z",
  "venues": [
    {
      "id": "fictional-moonbeam",
      "profile": "other",
      "packet": "packets/fictional-moonbeam",
      "package": "package.json",
      "ledger": "source-ledger.json",
      "coverage": "coverage.json",
      "sources": "sources",
      "acceptanceManifest": "acceptance-manifest.json",
      "destination": "fictional-moonbeam"
    }
  ]
}
```

`packet` is relative to the batch manifest's directory. All other input names are relative to that packet, except saved evidence and package references inside an acceptance manifest, which are relative to that manifest. The package, ledger, coverage and sources names shown above are defaults. No directory discovery selects additional venues. `asOf` is an explicit canonical UTC timestamp; checks use its UTC calendar date. Reports are snapshots at this timestamp, not evidence of a later live state.

`id` and `destination` must each be unique ignoring case, with 1–80 ASCII letters, digits, underscores or hyphens, starting with a letter or digit. Windows reserved device names are rejected. Destinations are direct children of the new output directory.

Optional `checks` is a nonempty unique subset of `sourceIntegrity`, `coverage`, `guidePreview`, `acceptance`. Omit it to request all four. Requesting `acceptance` requires all four checks in the same run. For a local source/coverage check, use `"checks": ["sourceIntegrity", "coverage"]`.

The auditor ledger contract is in [venue-source-audit.md](venue-source-audit.md). Ledger source targets must be explicit, contained under `sources`, and hash-bound. The batch never repairs a ledger, modifies source files, invents facts or edits the package to make a checker pass.

## Evidence and outcomes

Each destination retains:

- `result.json`, including original input hashes and hashes checked again after execution;
- each available stage report, including negative reports from children exiting nonzero;
- each process record, including exact argument array, entrypoint hash, exit status, bounded stdout/stderr, timeout and tree-kill evidence;
- deterministic failure records when a stage cannot run;
- a task-local `tmp/`, passed only to that child's `TEMP`, `TMP` and `TMPDIR`;
- when acceptance identity is supplied, a new acceptance manifest, generated local evidence envelopes and an origin record.

The output root also contains `batch-result.json` and `summary.txt`. The batch report binds the original batch manifest and six tool entrypoints by SHA-256. These hashes do not attest to every transitive import, installed dependency or the host. Partial hashes remain available when a later input is missing or malformed. Input changes or disappearance after execution fail that venue while allowing later venues to finish.

`MEASURED` means that a child produced saved JSON. It is never sufficient to declare success. Inspect `processPassed`, `readinessPassed`, the saved report and, for publication, the acceptance verdict. Malformed/missing reports are `NOT_MEASURED` and fail the check.

The report separates these dimensions:

| Dimension                | What a passing value establishes                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `structural`             | The production guide preview parsed this create-only package and produced valid, untruncated default/evidence metrics. This does not create a `checkPackage` observation.        |
| `sourceIntegrity`        | The retained-source auditor's declared file and hash checks passed. Semantic truth and extraction fidelity remain unverified.                                                    |
| `freshness`              | The auditor's explicit freshness conditions passed for the requested date. It does not refresh the source or change its dates.                                                   |
| Coverage stage readiness | Coverage schema/linkage/freshness checks passed and no row has `BLOCKS`, `NEEDS_HUMAN`, `CONFLICTED` or an undisclosed `UNKNOWN`.                                                |
| `publicationReadiness`   | All requested local checks and the existing acceptance composer's complete predicates passed. A candidate does not authorize publication or prove an attestation's authenticity. |

Coverage can exit `0` and remain `MEASURED` with `readinessPassed: false`: valid coverage rows can still block publication. Batch readiness fails in that case. The saved acceptance receipt retains the same negative coverage finding.

## Acceptance without invented hosted evidence

`acceptanceManifest` is optional. Without it, acceptance fails deterministically with `NOT_READY`; the runner does not invent tenant or venue identities. The supplied manifest must identify the packet's exact package and use the existing acceptance manifest format.

Only generated coverage and guide-preview envelopes replace their corresponding supplied entries, in a **new output manifest**. Their reports retain the original package/source bindings. These local envelopes are valid only at the exact `asOf` instant (expiration is one millisecond later); they must be regenerated for a later measurement. Original inputs and hosted envelopes remain unchanged. `acceptance-origin.json` records the supplied manifest hash and generated evidence kinds.

The runner accepts only the seven other known evidence kinds: `checkPackage`, `import`, `guestLink`, `embeddings`, `servingRoute`, `visitorQa`, `phoneCheck`. Their files must be inside the packet. The existing composer validates their hashes, identity, time windows, deployment binding and typed predicates. Missing hosted evidence stays `NOT_READY`. A positive supplied receipt cannot override a failed generated local check.

Known filename/path guards reject `questions.json`, `expected-facts.json`, Gold/holdout names (including common dot, space, underscore and hyphen suffixes), common credential names and browser-profile names before reading them. These guards apply to canonical manifest paths and canonical packet-relative input paths, so aliases cannot conceal a guarded name. They are not a content classifier or authentication of arbitrary packets; use only explicitly selected local authoring packets. The runner also rejects traversal, absolute packet-relative paths, network share paths, unsafe Windows names, source-tree symlinks, escaping input links and input/output overlaps. Output ancestry must resolve to its stated local path; aliases cannot evade overlap checks, including when a packet is malformed. Sources are inventoried only under explicitly supplied packet roots, with a 10,000-file ceiling.

## Process bounds and tests

Children use `process.execPath` with explicit argument arrays and `shell: false`. The production preview retains its own existing Windows-safe renderer launch. Each stage defaults to a 30-second limit; `--timeout-ms` accepts 10–300000 milliseconds. Captured output is capped at 4 MiB per process. A timeout/output limit fails the stage and retains its process record.

On Windows, timeout cleanup invokes `taskkill.exe /PID <owned-child> /T /F`, then falls back to killing the direct child. On POSIX it kills the process group. Tree-kill result and `cleanupUnconfirmed` are explicit. A final four-second pipe-close bound prevents inherited pipes from holding the caller forever; Windows tree cleanup can add up to three seconds before this bound. This covers the supported parent/renderer topology. The exported `runProcess` and `toolRunner` injection are internal test seams, not a general subprocess-management API: already-orphaned or deliberately detached descendants are outside the cleanup guarantee. Unconfirmed cleanup remains a failure, never a successful check.

Run focused tests with `TEMP`/`TMP` pointed to the allocated external task's `tmp` directory:

```powershell
node --test scripts/venue-authoring-batch.test.mjs
```

The suite uses fictional packets and a clearly isolated preview fixture for most composition cases; it executes the real source auditor, coverage checker and acceptance composer. Set the process-local `TORCHIKO_BATCH_REAL_PREVIEW=1` only when the existing production preview's local `pnpm`/`tsx`/workspace dependencies are available to also run the production renderer integration test. No dependencies are installed by the runner or tests. Otherwise that single integration test is explicitly skipped.

Tests cover Windows argument metacharacters, bounded child failure/timeout, supported descendant cleanup, mixed venue outcomes, partial hashes, changed/disappearing inputs, measured coverage blockers, missing hosted evidence, reruns, duplicate destinations, traversal, junction escapes and canonical overlap, including malformed packets. No live hosted acceptance, publication, source semantic review or extraction-fidelity review is claimed.

## Coverage coupling and rechecks

Every batch venue must declare `profile`: one of `amusement`, `zoo-wildlife`, `museum`, `garden`, or `other`. The packet's `coverage.profile` and measured coverage profile must equal it; mismatches fail with `COVERAGE_PROFILE_MISMATCH`. Missing or unsupported declarations fail invocation with `VENUE_PROFILE_REQUIRED`. The tool never infers a venue's factual profile.

Every source cited by coverage must pass the retained-source auditor in this run as a text target with the identical canonical path and SHA-256. Missing audit checks, raw-only declarations, failed sources, a cited source's own integrity or freshness failure (explicitly stale, overdue or invalid dates), and divergent bindings produce `COVERAGE_SOURCE_NOT_AUDITED` with the specific reason and fail coverage readiness. A source that merely declares no `recheckBy` is reported once, as ledger freshness `NOT_VERIFIED` in `sourceIntegrity`, which still blocks publication; it does not mark other cited sources unaudited. For coverage with cited sources, include both `sourceIntegrity` and `coverage` in the selected checks.

Legacy authoring ledgers (rawPath/rawFile/capturePath, textPath/textFile, sha256 of the raw capture, textSha256) can be mapped to the strict format with `node scripts/venue-ledger-migrate.mjs --ledger <legacy> --sources-dir <sources> --coverage <coverage> --output <new strict ledger> --report <report> [--attested-text <json>]`. It only relabels declared hashes and dates; a source's `recheckBy` comes from a legacy value or the earliest coverage row citing it, never from an assumed age. Targets outside `sources`, undeclared hashes, failed fetches and conflicting ids are listed in the report and left out; the legacy ledger is never modified.

Nonempty `readinessFindings` also fail coverage readiness, with `READINESS_FINDING` reasons naming each category and record pointer. A checker contract PASS cannot override those reasons. Each prepared venue saves `RECHECK-REGISTER.json`, bound by hash in `result.json`, even when later checks fail. It preserves the package itemKeys, coverage statuses, earliest deadlines and unbound labeled facts. The batch root binds the checker Git blob as `checkerVersion`; both coverage and register reports also bind it. See [venue-coverage.md](venue-coverage.md) for the register and D3 defaults.
