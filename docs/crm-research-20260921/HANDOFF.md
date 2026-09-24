# Torchiko CRM — accepted local staging foundation

**September 21, 2026. Local staging acceptance only; not a production release.**
Continues the existing September 19 worktree and native CRM. No replacement CRM,
new worktree, reset, clean, container recreation, source mutation or deployment.

## Exact owner and evidence

- Worktree: `C:\Users\tomsc\Downloads\PathFinder-crm-research-20260919`
- Branch: `codex/torchiko-crm-research-20260919`
- Parent: `1c743bad16b3b1d5c29d92b030a0ae8a2b7356eb`
- Final commit is recorded after commit in the vault's primary `HANDOFF.md` and
  `artifacts/crm-research-20260921-r001/DELIVERY.json` (not a self-referential hash here).
- Machine-readable acceptance, counts and SHA-256 receipt inventory:
  `docs/crm-research-20260921/ACCEPTANCE-RECEIPT.json`.
- Private package, full receipts, previous failures and screenshots:
  `artifacts/crm-research-20260921-r001/`. These are retained locally, ignored by Git,
  and not copied wholesale into AwesomeVault or a production database.

Canonical workbook and byte-copy archive both remain SHA-256
`1e2d5c29aae124a616e5c037e9e75cfc4f35026ec838dbd39914a3bd8aa1d8ff`.
The workbook's old summary website total is stale: direct rows contain **14,804**.

Package `canonical-package-r001.json` has file SHA-256
`c398fa718e671d15acd7aaa136b10c457dbfb06e3f1b0529995eec13cdd4c70e` and native semantic
package SHA-256 `5da402aff674ec35c989c9f31e4e1db94c299474523302af8925012037fe593e`.
Import ID: `cmuanw9lm00008tesd8bh23o6`.

## Reconciled import

| Measure                                                |          Accepted result |
| ------------------------------------------------------ | -----------------------: |
| Territory sheets / native territories                  |                  85 / 85 |
| Source rows / package prospects / accepted source rows | 16,725 / 16,725 / 16,725 |
| Rejected / skipped source rows                         |                    0 / 0 |
| Organizations / venues / opportunities                 | 16,725 / 16,725 / 16,725 |
| Direct websites                                        |                   14,804 |
| Contact-bearing source rows                            |                    6,183 |
| Expanded source contact candidates                     |                    8,212 |
| Source evidence                                        |                   16,725 |
| Total native source records                            |                   41,662 |
| Failed / skipped native source records                 |                    0 / 0 |

Contacts are recorded candidates, **not independently verified people or send-ready
recipients**. All email readiness and permission states remain UNKNOWN. General
inboxes are not assigned to a named person by proximity. Owner labels never become
contacts. Historical scores/fit reasons remain raw evidence, not operational scores.

Stable converter identity is venue name + city + state. All 1,005 repeated website
groups remain separate venues; 2,594 additional website occurrences are not merged.
The native mapper namespaces IDs by workbook hash. Identical-package replay is
accepted; changed-workbook reconciliation is not implemented by this source-only lane.

Retained overlapping source exceptions, **not rejected or discarded prospects**:
1,921 missing websites; 1,528 missing source URLs; 247 missing research dates;
five owner-name-only rows; two contact-bearing rows without source URLs; eight
title-only contact rows. Exact locators remain in `source-reconciliation-r001.json`.

`dry-run-r002.json` and `full-import-r002.json` retain successful conversion/native
import. `identical-import-replay-r001.json` reused the same import/package identity,
processed zero new records and finalized as COMPLETE without changing provenance.
Full-row fingerprints for **all 42 captured tables** match before replay, after
replay and after the final verification. This includes timestamps, IDs, audit and
source/contact content, not merely row counts. No duplicated contacts or overwrite.

## Verification

| Gate                                                         | Result                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| Independent workbook XML/package reconciliation              | 631,930 checks passed                                    |
| Fresh exhaustive native DB readback                          | 858,112 checks passed                                    |
| Actual native API/authorization/filter/pagination readback   | 51,453 checks passed                                     |
| Import/environment/converter tests                           | 17 passed                                                |
| Full DB suite                                                | 2,148 passed; 136 optional integration tests skipped     |
| Full API suite                                               | 2,703 passed; 108 optional integration tests skipped     |
| Full dashboard suite                                         | 1,566 passed, zero skipped                               |
| Workspace typecheck                                          | 27 tasks passed                                          |
| Workspace lint                                               | 15 tasks passed; existing warnings retained, zero errors |
| Public surface, tenant procedures/registry/bypasses, raw SQL | All five passed                                          |
| Dashboard production build and final dashboard typecheck     | Passed                                                   |
| Browser directory/detail journey                             | Passed; six retained screenshots                         |

Skipped optional disposable suites are not claimed as executed. The retained local
database was independently exercised through the full import, exact readback,
all-territory/API traversal and identical replay. The live API receipt is the retained
`api-live-acceptance-r001.json`; an attempted later command omitted `--readback` and
did not rerun it. DB/API full suites and current-code browser checks were rerun.

Authoritative final logs are under `final-r001/`: `db-suite.log`, `api-suite.log`,
`dashboard-suite-r004.log`, `workspace-typecheck-r002.log`, `workspace-lint-r002.log`,
`native-gate-results-r002.json`, `dashboard-build-r002-result.json`,
`dashboard-final-results.json`, `full-readback.json`, `db-final.json`, and the five
boundary logs. Initial failed logs remain visible. The earlier generic checkpoint's
larger source-check count is superseded by the actual 631,930-check source receipt.

Two final harness repairs matter for reproducibility: PowerShell's terminating
stderr behavior misclassified native banners/warnings, so final runners capture
native exit codes with nonterminating stderr; and dashboard Vitest now retains
default exclusions plus `.next-*/**`, preventing generated standalone vendor tests
from being mistaken for application tests. No application tests were removed.

## Existing directory/detail, not another dashboard

The shared native directory and extracted existing detail view now expose territory,
search, recorded/unknown contacts, source provenance and stable cursor navigation.
The local adapter invokes the actual native read owners. Production admin routes
keep platform-admin authorization; the acceptance adapter is development-only,
explicitly opted in, exact-loopback, read-only, no-store and cross-origin guarded.

Browser receipt `browser-r007/receipt.json` proves actual Edge rendering, search/
filters, cursor append without duplicate IDs, source/detail navigation, return-filter
preservation, recoverable read failure/retry, visible keyboard focus, UNKNOWN states,
desktop and 375/320-pixel overflow checks, and zero checked accessibility violations.
No uncaught JavaScript/hydration errors. Six PNGs are adjacent. Workbook calendar
dates now preserve their literal source day instead of inventing a time or shifting
to the previous local day; regression tests and fresh visual proof cover the fix.

Desktop MCP `observe` is still unavailable. Browser proof used actual Playwright
Edge instead, not a claim that Desktop was repaired. The authenticated hosted Clerk
shell, non-Edge/device-specific rendering and production deployment remain unverified.

## Safe local access / continuation

Existing preview: `http://127.0.0.1:58618/dev-fixtures/prospect-research`.
The retained database must remain:
`torchiko-crm-research-db-20260919`, `127.0.0.1:58617`,
`pathfinder_disposable_crm_research_20260919`, with its original persistent volume
and 250 existing migrations. Start that same container if stopped; do not recreate it.

From this worktree, `powershell -NoProfile -File scripts/run-local-crm-research.ps1 preview`
starts the fixed loopback preview when it is not already running. Reuse the running
instance rather than launching another. The helper obtains only the retained local
container's credential in memory; it does not read production `.env` files.

The importer/readback helpers execute from `packages/db`, so pass **absolute paths**
to packages and receipts. Reuse the existing immutable package; new receipt names
must be unique because evidence is exclusive-created. An identical replay is already
proven; repeating it is unnecessary for merely browsing the local CRM.

Initial dirty diffs/untracked inventories and byte backups were retained before
edits. All coherent owned CRM source is committed, while generated
`apps/dashboard/next-env.d.ts` and `apps/dashboard/tsconfig.json` are intentionally
left uncommitted with their existing local build-directory references. Do not reset
those or the worktree to manufacture a clean status. No source package or credentials
are in the commit. Git HEAD is the source delivery boundary, not production promotion.

## Future sales component compatibility

`SALES-COMPONENT-INTEGRATION.md` maps the actual native identity/evidence/research,
draft/revision/approval/frozen-recipient, correspondence, reply, suppression and
follow-up owners to the new vault-local pre-send component contracts. No component
package was copied wholesale and no second state owner was introduced.

Concrete mismatches are explicit: non-campaign/UNKNOWN/form-route preparations do
not fit the existing email-ready campaign draft writer; Composer/native/WLT hashes
have different byte definitions; pilot/native identities require a verified crosswalk;
new evidence needs a real source-catalog admission path; and reducer projections need
a reviewed native version/concurrency seam, not an overwritten human review record.
Those future changes are contract work for a separately authorized lane, not hidden
unfinished importer work or an implemented sender.

**No Gmail send, authentication, contact form, campaign, deployment, inferred consent
or production mutation occurred. Campaigns, drafts, batches/items/outbox, messages,
threads and follow-ups remain zero in this local database.** The requested local
foundation is populated and accepted; delivery activation remains unauthorized.
