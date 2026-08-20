# Prospect CRM architecture

Status: implemented on `codex/torchiko-crm-foundation-20260819`  
Migration: `20260819213000_add_prospect_crm_foundation`

## Purpose and boundary

The prospect CRM is Torchiko's platform-owned source of truth for organizations and venue locations that are not yet customers. It is deliberately separate from the tenant-owned `Venue` model. A prospect becomes a customer only through an explicit, audited conversion link; conversion does not delete or rewrite the prospect record.

This slice does not send email, activate outreach, ingest inbound mail, schedule meetings, run autonomous prospecting, or expose prospect data on a public surface. Activity types reserve clean integration points for those future systems, but no live communications are implemented.

## Domain model

| Record                                                       | Responsibility                                                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ProspectTerritory`                                          | Platform-owned sales/research geography and assignment bucket.                                                                      |
| `ProspectOrganization`                                       | Canonical parent identity, normalized name/domain, research provenance, owner, priority, tags, notes, and archive state.            |
| `ProspectVenue`                                              | A location or operational venue belonging to a prospect organization. It is not a customer `Venue`.                                 |
| `ProspectContact`                                            | A person or general contact point, including provenance and do-not-contact state.                                                   |
| `ProspectOpportunity`                                        | One lightweight pipeline record per organization: stage, priority, owner, next action, reason, and activity timestamp.              |
| `ProspectStageHistory`                                       | Append-only evidence of pipeline transitions.                                                                                       |
| `ProspectActivity`                                           | Unified chronological timeline for research, notes, imports, stage changes, future communications, archive events, and conversion.  |
| `ProspectSourceEvidence`                                     | Source-level captured values and URLs, including immutable spreadsheet-row linkage.                                                 |
| `ProspectDuplicateCandidate`                                 | Conservative organization-pair candidate with score, reasons, and an explicit human resolution. It does not merge records.          |
| `ProspectImport`, `ProspectImportSheet`, `ProspectImportRow` | Retained file/mapping hashes, selected sheets, source rows, validation outcomes, review decisions, and row-level results.           |
| `ProspectConversion`                                         | Unique, durable bridge from one prospect organization (and optional prospect venue) to one customer tenant and optional live venue. |

All CRM tables are registered as platform tables in `packages/db/src/tenanted-tables.ts`. They may be accessed only through platform-admin procedures wrapped in the repository's explicit tenant-isolation bypass. The bypass is auditable; prospect records themselves do not acquire a tenant before conversion.

## Pipeline

The supported stages are:

`DISCOVERED → RESEARCHED → NEEDS_REVIEW → READY_FOR_OUTREACH → CONTACTED → FOLLOW_UP_DUE → REPLIED → CONVERSATION → QUALIFIED → PROPOSAL_DECISION → WON`

`LOST`, `PARKED`, and `DO_NOT_CONTACT` are terminal/paused outcomes and require a human-entered reason. The system records every stage transition in `ProspectStageHistory` and also adds an activity-timeline event. Conversion sets the opportunity to `WON` and retains the prior stage as history.

## Identity and duplicate policy

Normalization is intentionally conservative:

- names are Unicode-normalized, case-folded, punctuation-normalized, and stripped only of a small set of legal suffixes;
- domains are extracted from valid host names and ignore `www.`;
- email comparison accepts only structurally valid email values;
- hashes use canonicalized JSON and SHA-256.

Manual creation is stopped when an active record has an exact normalized name, domain, or contact email. Import candidates compare exact normalized organization name, venue name and city, domain, and contact email. Candidate evidence is scored and presented for review. Neither the domain action nor the UI offers a destructive merge; a confirmed duplicate is a recorded decision only.

## Domain-action boundary

All writes flow through `packages/db/src/helpers/prospect-actions.ts`. The current contract requires a human `PLATFORM_ADMIN` actor and writes the strict audit log. API inputs have bounded strings, arrays, batch sizes, and pagination. Direct database writes from UI or future agents are not an approved extension point.

Future agent integrations should use the same pattern:

1. read through bounded platform-admin queries;
2. propose research as source-evidenced activity or import rows;
3. require a human review decision for identity ambiguity, pipeline terminal states, outreach, and conversion;
4. call a domain action with an explicit actor/run identity and evidence;
5. never silently merge, contact, archive, or convert a prospect.

The currently exported actions provide the stable service boundary for creation, pipeline changes, notes, archival, import staging/review/commit, duplicate scans/resolutions, and conversion. Agent actor support is not enabled in this implementation.

## Internal surfaces

- `/admin/prospects`: searchable/filterable directory and manual creation entry point.
- `/admin/prospects/new`: manual organization, optional venue, and optional contact capture.
- `/admin/prospects/[prospectId]`: identity, locations, contacts, opportunity actions, activity, provenance, archive control, and conversion launch.
- `/admin/prospects/pipeline`: grouped operational pipeline.
- `/admin/prospects/duplicates`: bounded scan and non-destructive review queue.
- `/admin/prospects/imports`: local CSV/XLSX parsing, sheet/mapping confirmation, preview, dry run, duplicate review, approval, batch commit, and retained history.

These routes are internal and use the existing admin shell. No widget, public website, guest chat, or client portal route consumes CRM data.

## Operational characteristics

- Directory reads are paginated and indexed by normalized identity, territory, owner, stage, priority, and next action.
- Import staging is limited to 250 rows per request; commit is limited to 100 rows per transaction loop.
- Duplicate scans are bounded to 20,000 organizations and 5,000 candidate pairs per run.
- Archive is reversible and cascades archive state to the prospect's venues and contacts without deletion.
- Conversion is unique per prospect and retry-safe for the same tenant/venue target.
- Source rows and evidence are retained; the original spreadsheet binary is parsed locally and is not uploaded or stored by this slice.

## Security and privacy notes

Contacts and research evidence are platform-internal personal/business data. They are not tenant-visible before conversion and are not automatically copied into communications. `doNotContact` and suppression fields are stored now so a future communications system can enforce them. Any retention/deletion policy activation must extend the existing privacy architecture explicitly; this implementation does not invent a deletion policy.
