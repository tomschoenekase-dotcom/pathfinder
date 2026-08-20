# Implementation: CRM foundation and spreadsheet migration

Date: 2026-08-19  
Branch: `codex/torchiko-crm-foundation-20260819`  
Base commit: `7b4ee32`  
Migration: `20260819213000_add_prospect_crm_foundation`

## Implemented

- Platform-owned prospect territories, organizations, venues, contacts, opportunity, stage history, activity, provenance, duplicate candidates, retained imports/rows, and conversion link.
- Human platform-admin domain actions with strict auditing, bounded inputs, reversible archive, required terminal-stage reasons, and non-destructive duplicate decisions.
- CSV/XLSX browser parsing, sheet detection/selection, mapping, normalized preview, SHA-256 identity, batched dry run, warnings/errors, duplicate review, approval gate, bounded commit, idempotent replay, row-level partial failures, source evidence, and import history.
- Admin directory, manual create, detail, pipeline, duplicate review, and import surfaces in the existing PathFinder OS shell.
- Retry-safe integration with the existing customer/venue creation surface and a permanent prospect conversion link.
- Database/API/dashboard tests for normalization, authorization, input limits, unsafe merges, malformed/import warning paths, duplicate review, partial failure, idempotency, provenance/history, and conversion.

## Explicitly not implemented

- Live email, autonomous outreach, sequences, inbound mail, or calendar scheduling.
- Destructive prospect merging or automatic cross-import identity consolidation.
- Public, guest-chat, widget, or client-portal exposure of prospect data.
- Client analytics, billing/refunds, geographic knowledge graphs, or unrelated migrations.
- Golden Venue, intake upload, guest chat, or native-release behavior changes.
- Automatic import rollback. Row-to-record provenance provides repair evidence; archive is the safe current reversal mechanism.
- Agent write authority. The service actions are the future extension point, but this release accepts only authenticated human platform administrators.

## Isolation and integration notes

Work was implemented in the separate worktree `C:\Users\tomsc\Downloads\PathFinder-crm-foundation`. The source checkout's active Golden Venue/intake changes were not modified. Shared changes are limited to:

- Prisma schema and migration registry;
- the admin router merge point;
- admin navigation;
- the existing create-client form, solely to accept prospect prefill and call the audited conversion link;
- dashboard dependency/lockfile for browser-side SheetJS parsing.

Pre-merge review must compare the final Prisma schema, `_admin.ts`, `AdminSectionShell.tsx`, `AdminCreateClientForm.tsx`, dashboard package manifest, and lockfile against any newer Golden Venue branch changes. Do not auto-merge the branch.

## Data migration readiness

Tom's actual `PathFinder_Prospects_Tier1.xlsx` was inspected read-only. It is within file/sheet limits and its 31-column territory schema matches the default mappings. It is ready for an operator-controlled dry run after deployment. It is not approved for blind import because the vault contains evidence of corrupted/duplicate rows and the workbook includes missing research fields. No real prospect data was written during this implementation.

## Verification record

Final local verification on 2026-08-19/20:

- Prisma schema validation and isolated client generation passed.
- All 126 migrations applied from an empty disposable pgvector PostgreSQL database; the reviewed staging manifest now freezes the 126-file chain and its expected 139-table result.
- A real disposable-database CRM lifecycle passed, including duplicate-review gating, an injected row failure, partial status, idempotent retry, provenance, and conversion uniqueness/history.
- The full monorepo test command passed all 23 package tasks. Relevant totals included DB 1,063 passed/82 skipped, API 1,118 passed/57 skipped, dashboard 715 passed, web 304 passed, and workers 371 passed/1 skipped.
- All 170 repository script checks passed (169 passed, one intentional skip), including migration lineage, public-surface inventory, admin-router modularity, tenant-boundary policy, secrets scanning, and product-copy boundaries.
- Full production browser-bundle verification built all 13 packages and scanned 421 browser files against 11 secret canaries.
- Tenant registry verification passed for 138 models (115 tenanted, 21 platform, 2 shared); the explicit bypass verifier passed 217 calls across 70 approved production files; 98 generated cross-tenant API tests passed.
- Root lint passed with one pre-existing non-blocking `<img>` optimization warning in `apps/web/components/PlaceCard.tsx`. Root typecheck and the affected API/dashboard typechecks passed after aligning the import-detail response contract.
- Prospect-specific checks passed: 9 normalization/action tests, 3 API authorization/input-boundary tests, 5 dashboard conversion/accessibility tests, and the disposable lifecycle test.

The local server started and the route was opened through the in-app browser, but a real authenticated admin journey could not be completed because the isolated worktree had no valid Clerk session/configuration. Automated axe checks cover the new CRM directory and import surfaces; release review should still perform one signed-in browser smoke test before staging approval.

No staging or production migration was executed, and no real workbook rows were imported.
