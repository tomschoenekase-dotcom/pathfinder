# Legacy Outreach SQLite migration and reconciliation

Status: migration tooling implemented; no production Postgres import has been run.

Postgres/Torchiko is the sole intended operational source of truth. The local
PathFinder Outreach SQLite database is a migration source and, after an approved
Postgres migration and reconciliation, a read-only legacy archive. It must not
become a second live writer and there is no bidirectional-sync design.

## Safe inventory captured on 2026-08-20

The source inspected read-only was the configured non-empty database under the
Tom OS `02 Projects/PathFinder/Outreach/data` directory. The inspection did not
print prospect or contact rows and did not modify the file.

- SQLite schema version: `2`
- File size: `34,775,040` bytes
- Database SHA-256: `0692457561cdec0a9cacf22c8a80d868714dbc0b2a9a890c7cdf92b0e2acc91a`
- Schema SHA-256: `67e40e290be4e23b32141be9b7637d253375bc5f9776a1f78126b87635427709`
- `PRAGMA integrity_check`: `ok`
- Foreign-key violations: `0`
- Data rows covered by the bundle mapper: `22,653`
- Unmapped data rows: `0`
- Metadata rows not emitted as records: `1` (`schema_meta`)

| Legacy table                                                                  |   Rows | Content SHA-256                                                    |
| ----------------------------------------------------------------------------- | -----: | ------------------------------------------------------------------ |
| prospects                                                                     | 16,405 | `5c5ba4403b6b06cda82b7f72a8b9c7a434e0f5fb17d155f3b8641b8a05240820` |
| contacts                                                                      |  5,880 | `f2c1d09f93d36f1cdcc78ba20ea412b4d1b5b4b9d995f0f0d349afca608259fd` |
| audit_log                                                                     |    359 | `6b8e321ca4a21043d15b7eb44367b01e978e2c740a847b4886d2c400f3e40138` |
| templates                                                                     |      9 | `785939b431d9c2871f142559effbd327218af1f20709984a50b8493f5175bdfb` |
| campaigns, campaign_prospects, drafts, interactions, followups                | 0 each | SHA-256 of empty content                                           |
| send_batches, send_batch_items                                                | 0 each | SHA-256 of empty content                                           |
| agent_runs, agent_questions, agent_question_messages, agent_resume_dispatches | 0 each | SHA-256 of empty content                                           |
| schema_meta                                                                   |      1 | `37c24cb765521bc7b4af4675f802b789d3d2f608c95f416e8b745dc5025329e1` |

The two zero-byte database files beside the configured database are not ledger
sources and the tool rejects empty files.

### Review cohorts, not automatic merges

The aggregate inspection found:

- 404 normalized email values used by more than one contact;
- 1,005 repeated normalized website/domain values;
- 1,022 prospects with more than one explicit contact;
- 11,547 prospects without an explicit row in `contacts`;
- 8 inactive prospects;
- 0 repeated source fingerprints;
- 0 contacts marked do-not-contact in this source.

Repeated emails and domains are duplicate-review evidence, not proof of a
duplicate organization. Shared front-desk addresses and multi-location domains
are expected. A Postgres consumer must stage these candidates for explicit
`link`, `update`, `distinct`, `skip/quarantine`, or `not duplicate` review. It
must not destructively merge them.

Prospect rows can contain `general_email` or `contact_email` coordinates that do
not have a matching explicit contact row. The bundle emits deterministic
synthetic contact records for those coordinates. Their readiness is
`UNKNOWN_REQUIRES_REVIEW`; presence in the source is not permission to contact.

## Tooling

The standard-library tool is
`scripts/legacy-outreach/legacy_outreach_bundle.py`. It has three commands:

```powershell
python scripts/legacy-outreach/legacy_outreach_bundle.py inventory `
  --source '<safe-copy-or-legacy.sqlite3>' `
  --output '<review-directory>/inventory.json'

python scripts/legacy-outreach/legacy_outreach_bundle.py export `
  --source '<safe-copy-or-legacy.sqlite3>' `
  --output-dir '<review-directory>/bundle'

python scripts/legacy-outreach/legacy_outreach_bundle.py reconcile `
  --source '<same-safe-copy-or-legacy.sqlite3>' `
  --bundle-dir '<review-directory>/bundle' `
  --output '<review-directory>/reconciliation.json'
```

The source is opened using SQLite URI `mode=ro`, `PRAGMA query_only=ON`, and
integrity/schema validation. Unknown tables or missing required columns fail
closed for human review. `inventory` emits only aggregate counts, columns, and
hashes. `export` contains prospect PII and therefore must be written only to an
approved encrypted or access-controlled review location; it must not be
committed.

`records.ndjson` is deterministic for a fixed source database. Every record has:

- a UUIDv5 identifier derived from the legacy system, entity kind, and legacy ID;
- the original SQLite table and ID;
- the source database and source-row SHA-256 hashes;
- explicit canonical links to related organization, venue, campaign, member,
  batch, draft, run, or question records;
- the retained legacy payload or a documented canonical projection.

One legacy prospect intentionally creates an organization, physical venue, and
opportunity projection. This preserves the current safe one-prospect-per-source
row identity; organization deduplication happens in reviewed Postgres staging,
not in the exporter. No legacy send record is assigned a Gmail or Resend identity
unless one existed in the source payload.

## Reviewed Postgres application contract

The bundle is an adapter boundary, not an authorization to write directly to
tables. A Torchiko application worker must consume it through the canonical CRM
domain actions and a durable import job. The apply transaction must:

1. verify the database, manifest, and record hashes;
2. create a dedicated import identity from the database hash and bundle version;
3. persist original table/ID and row hash as source provenance;
4. stage organizations, venues, contacts, evidence, and duplicate candidates;
5. preserve inactive legacy prospects as archived candidates;
6. carry contact uncertainty and do-not-contact values forward fail-closed;
7. apply only reviewed existing-record decisions;
8. record imported canonical IDs per bundle record for replay idempotency;
9. append a strict audit record and reconciliation result;
10. leave prospect delivery disabled.

Replaying the same bundle must resolve to the same deterministic IDs and must not
create a second campaign, contact, interaction, or customer conversion. A source
database whose hash differs from the manifest must be treated as a new candidate
import, never silently substituted.

## Reconciliation gates

Before calling migration complete, compare at least:

- every source table count and content hash;
- bundle record count and `records.ndjson` hash;
- Postgres staging/committed/skipped/quarantined/error counts;
- source legacy IDs to recorded canonical IDs;
- duplicate and existing-record dispositions;
- imported versus archived prospect counts;
- explicit and synthetic contact counts;
- campaign, draft, interaction, follow-up, batch, agent-question, and audit counts;
- foreign-key violations and orphan references;
- source database SHA-256 before and after export.

The fixture test covers source immutability, deterministic repeated export,
legacy provenance, embedded-contact uncertainty, reconciliation, bundle tamper
detection, and fail-closed handling for an unreviewed table:

```powershell
python scripts/legacy-outreach/test_legacy_outreach_bundle.py
node --test scripts/legacy-outreach-bundle.test.mjs
```

## Cutover and archive procedure

Do not change the source ledger before an approved production-like rehearsal.
After the Postgres import and reconciliation are approved:

1. stop every legacy CLI, admin server, workbook-sync job, and agent integration;
2. take a final filesystem copy and record its SHA-256;
3. export and apply that exact final copy;
4. reconcile Postgres and receive operator approval;
5. remove or disable mutation entry points in the legacy launcher/configuration;
6. mark the Obsidian notes as legacy/read-only while retaining strategy,
   templates, playbooks, decisions, and this evidence;
7. retain the final SQLite database according to the approved privacy policy;
8. monitor for attempted legacy writes and treat one as a cutover incident.

The current repository tooling does not itself chmod the vault, edit its config,
or import Postgres. Those are deliberately separate, reviewable cutover actions.
