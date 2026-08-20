# Spreadsheet import guide

## What the workbench accepts

The internal import workbench at `/admin/prospects/imports` accepts `.csv` and `.xlsx` files up to 25 MB. A workbook may contain at most 100 selected sheets, each with at most 100,000 detected data rows and 200 detected columns. Files are parsed in the operator's browser with SheetJS; the server receives bounded row batches, not the original binary.

The file hash and mapping hash form an import identity. Repeating the same file contents with the same mapping reopens the retained import instead of creating a second import. Changing the mapping intentionally creates a different import identity.

## Workflow

1. Choose the file. Malformed, encrypted, unsupported, or oversized files stop before any server write.
2. Confirm the selected sheets. Sheets containing `venue_name` are selected by default; summary/helper sheets without that column are excluded by default.
3. Confirm column mappings. Venue name is required. Optional empty columns remain empty—Torchiko does not invent contacts, organizations, or research facts.
4. Review the normalized preview.
5. Run the dry run. Rows are sent in batches of at most 250 and retained with their original sheet name, row number, source values, normalized values, fingerprint, warnings, errors, and possible duplicate matches.
6. Resolve every duplicate candidate. Mark it `Import as distinct` with evidence or `Skip row` with a reason. Approval remains disabled while a candidate is unresolved.
7. Approve. Only `VALID` and reviewed `WARNING` rows become eligible.
8. Commit. The workbench processes at most 100 rows at a time and reports progress. Completed rows are idempotent; a retry does not import them twice.
9. Read the retained result. `COMPLETE` means every eligible row imported. `PARTIAL` means at least one row failed, was skipped, or required a terminal review outcome. Row-level errors and source evidence remain available for repair.

## Default mappings for the PathFinder prospect workbook

| CRM field                | Workbook column                                                     |
| ------------------------ | ------------------------------------------------------------------- |
| Venue name               | `venue_name`                                                        |
| Parent organization      | `owner_name`                                                        |
| Venue type/subtype       | `venue_type`, `venue_subtype`                                       |
| City/state               | `city`, `state`                                                     |
| Website                  | `website`                                                           |
| General/contact email    | `general_email`, `contact_email`                                    |
| Contact name/title       | `contact_name`, `contact_title`                                     |
| Phone                    | `phone`                                                             |
| Fit and use case         | `pathfinder_fit_score`, `fit_reason`, `primary_use_case`            |
| Priority/personalization | `outreach_priority`, `personalization_hook`                         |
| Research evidence        | `research_confidence`, `research_date`, `source_urls`, `notes`      |
| Territory                | Explicit `territory` column when present; otherwise the sheet name. |

If `owner_name` is empty, the venue name becomes the organization name. Rows from the same import with the same normalized organization name are grouped under one imported organization. No record from a previous import is silently reused; a matching pre-existing prospect is held for review.

## Validation and warnings

Hard failures include missing venue/organization identity and server-side input-limit violations. Warnings include missing websites, missing source URLs, malformed websites, and malformed emails. Warnings are importable after the dry run; errors are not. Exact identity signals create `DUPLICATE_REVIEW`, not an automatic update or merge.

For every imported row, Torchiko creates a source-evidence record containing the original values and row identity, plus an `IMPORTED` activity. Contacts and venues retain their source-import-row link. This is the repair and rollback evidence: the system can identify exactly which records came from which import row. Automatic destructive rollback is intentionally not implemented because imported rows may be enriched or converted after import.

## Repair procedure

For a failed row, inspect the retained row error and source values. Correct the source workbook or mapping, then run a new dry run. A changed file or mapping produces a distinct import history entry. Do not delete the prior import; it is the audit record. If an imported prospect is later found invalid, archive it with a reason rather than deleting it.

## Readiness of Tom's workbook

The inspected workbook `PathFinder_Prospects_Tier1.xlsx` is 3,582,835 bytes and therefore inside the 25 MB limit. It contains 86 sheets and the summary reports 16,397 prospects across 85 territories, also inside the sheet limits. The territory sheets use the expected 31-column schema and the importer defaults match those headings.

It is ready for a controlled dry run, not for blind approval. Existing vault research notes document suspected duplicate/corrupted rows, and many rows lack websites or source URLs. Those rows will surface warnings or duplicate review. The operator should:

- retain the original workbook unchanged;
- use the default mapping and select the 85 territory data sheets, excluding the summary sheet;
- inspect the dry-run counts and a representative sample from large territories;
- resolve every duplicate candidate with evidence;
- approve only after the failed/warning distribution is understood.

No real workbook rows were imported during implementation or testing.
