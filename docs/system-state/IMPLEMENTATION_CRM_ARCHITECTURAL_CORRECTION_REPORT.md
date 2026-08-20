# Torchiko CRM architectural correction implementation report

Date: 2026-08-20

Worktree: `C:\Users\tomsc\Downloads\PathFinder-crm-staging-reconciled`

Branch: `codex/torchiko-crm-staging-reconciled-20260820`

## Executive verdict

**The corrected, staging-reconciled branch is ready for human merge review with prospect delivery
dark. It is not yet authorized for staging provider setup, real import, or email.**

The P0 data, authority, send-safety, conversion, and agent-boundary corrections are materially implemented and database-tested. The worktree is much safer than the preserved pre-correction snapshot. It is not complete enough for an optimistic merge recommendation because:

1. Gmail OAuth, encrypted credentials, HTTP transport, Pub/Sub verification, Prisma inbound storage,
   and scheduled sync/watch runtime are mounted, but no real credentialed smoke test is authorized;
2. the full synthetic import pipeline is now durable and tested locally, but still requires an
   authenticated staging rehearsal and Tom's real-workbook dry-run review;
3. local in-app browser QA now covers the CRM directory, outreach center, campaign review, frozen
   content, URL state, back/forward behavior, and 390 px mobile rendering, but an authenticated
   staging run through the real admin routes remains required;
4. authenticated staging browser QA and operator-configured Google smoke tests remain external gates;
   local fixture/browser and deterministic provider tests do not replace them.

No real prospect email, provider account, credential, Pub/Sub watch, DNS record, workbook, deployment, merge, or push was changed.

## Architecture decisions implemented

- PostgreSQL/Torchiko is documented as the canonical operational system.
- The legacy SQLite Outreach ledger has deterministic read-only inventory/export/reconciliation tooling; no bidirectional synchronization was created.
- Gmail is the only intended prospect correspondence provider. CRM Resend webhook ingestion now returns `410`; unrelated transactional Resend functionality is retained.
- Correspondence domain code targets `CorrespondenceProvider`, not Gmail campaign semantics.
- `ProspectOpportunity` is the canonical workflow-state owner; database guards reject writes to legacy workflow projections.
- Organization customer relationships and location conversions are separate, tenant-scoped, multi-location, and replay-idempotent.
- Agents execute through verified, leased Agent Runs with server-derived capabilities and scope. They remain read/draft/question only.
- Prospect delivery and CRM UI are fail-closed and off by default.
- Calendar, Meet, Drive, Bot Mode, and autonomous outreach remain off/deferred.

Primary decision records:

- `docs/adr/ADR-CRM-CANONICALIZATION-2026-08-20.md`
- `docs/system-state/IMPLEMENTATION_CRM_ARCHITECTURAL_CORRECTION_LEDGER.md`
- `docs/sales/PROSPECT_CRM_ARCHITECTURE.md`

## Data model and migrations

Correction migration: `packages/db/prisma/migrations/20260820150000_canonicalize_prospect_crm/migration.sql`.

The migration/schema adds or corrects:

- normalized platform tags and organization tag membership;
- correspondence provider accounts/mailboxes with credential references and health/cursor/watch metadata;
- provider/account-namespaced external identifiers and receipts;
- contact readiness, permission uncertainty, suppression, unsubscribe, bounce, complaint, and append-only events;
- organization customer relationships plus tenant-scoped child location conversions;
- immutable frozen send-item content;
- transactional send outbox, exclusive leases, attempts, ambiguity, and finalization state;
- canonical thread/provider mappings and normalized message metadata;
- composite paging/search indexes, including `pg_trgm`-backed search support;
- database guards for canonical workflow ownership and append-only histories.

The full 132-migration chain applied successfully from empty to a fresh disposable pgvector
PostgreSQL database and produced 164 public base tables. The staging manifest is pinned to count
132 and hash `d2e6f3cb623872a614ea534101e5c988952ab46f31611b5e1eee492898611c61`.
The fresh-chain rehearsal caught and corrected a cross-table trigger branch defect before handoff.
A second populated upgrade rehearsal applied the 127 pre-correction migrations, loaded 20,000
organizations/venues/contacts/opportunities plus 1,000 frozen sends/messages/events/receipts, then
applied all five correction migrations. It caught and corrected a missing legacy email-event
provider-account backfill. The canonicalization migration completed in about 4.6 seconds on this PC;
the four following migrations each completed in about 0.2-0.25 seconds. All seeded counts,
canonical workflow projections, 30,000 normalized tag memberships, 200 suppression histories,
legacy conversion links, frozen bodies, and provider namespaces reconciled exactly. Staging must
confirm permission to create/use `pg_trgm` and rehearse on a sanitized production snapshot before
deployment.

Tenant registry verification passed with 163 Prisma models classified as 117 tenant-owned, 44 platform-owned, and 2 shared. Customer relationships and location conversions are explicitly tenant-scoped; provider/outbox/tag/contactability records are platform-scoped.

## Legacy SQLite migration and reconciliation

Read-only source inventory:

- size: 34,775,040 bytes;
- SHA-256: `0692457561cdec0a9cacf22c8a80d868714dbc0b2a9a890c7cdf92b0e2acc91a`;
- schema version: 2;
- schema hash: `67e40e290be4e23b32141be9b7637d253375bc5f9776a1f78126b87635427709`;
- integrity check: OK;
- foreign-key violations: 0;
- prospects: 16,405;
- contacts: 5,880;
- audit rows: 359;
- templates: 9;
- mapped data rows: 22,653;
- repeated normalized-email cohorts: 404;
- repeated website/domain cohorts: 1,005;
- prospects with multiple explicit contacts: 1,022;
- prospects without explicit contact rows: 11,547;
- inactive prospects: 8;
- existing do-not-contact contacts: 0.

`scripts/legacy-outreach/legacy_outreach_bundle.py` creates deterministic UUIDv5/provenance NDJSON and a reconciliation report. It refuses unknown schemas, non-empty WAL state, overwrite, or source drift. Embedded-email contacts are emitted as `UNKNOWN_REQUIRES_REVIEW`. Six Python tests and the root Node wrapper test pass.

No real Postgres import/export was performed. The SQLite file remained unchanged. Therefore canonical ownership is designed and migration-ready, not operationally cut over.

## Gmail provider/account runtime

Implemented:

- provider-neutral send/retrieve/thread/incremental/full/watch/ambiguous-lookup/health contract;
- namespaced provider/mailbox/account references;
- Gmail MIME normalization and text-only send construction;
- opaque encrypted-credential lease boundary;
- history cursor separated from page token;
- mailbox-scope validation;
- transient/authentication/post-acceptance ambiguity classification;
- deterministic fake provider and fixtures;
- bounded untrusted content and metadata-only attachments.

Production-mounted but operator-unconfigured:

- one-time, user-bound OAuth state plus PKCE and offline access;
- AES-256-GCM encrypted refresh-token storage behind an opaque credential reference;
- concrete Gmail REST transport and live worker provider factory;
- authenticated Pub/Sub JWT boundary with exact audience/service-account checks;
- initial and daily watch renewal plus independent 15-minute incremental reconciliation;
- provider health/cursor/watch persistence and a platform attention signal on failure.

The account is always connected with `deliveryEnabled=false`. No credentials were configured and
no Google network operation was performed. Before any dispatch, the worker independently requires
delivery activation and defaults to an internal-recipient allowlist; external recipients require an
explicit later switch to production recipient mode.

## Transactional outbox and send safety

Final release performs one database transaction that revalidates approved batch state, exact membership/count/hash, current eligible state, frozen recipient/content, and creates immutable send items plus outbox operations before marking the batch released. Publication is post-commit and recoverable by the periodic dispatcher.

Claims use exclusive leases. A worker may not freely reclaim `SENDING`; recovery requires lease expiry. Provider timeout after possible acceptance becomes `AMBIGUOUS` and is not blindly retried. The sender rechecks archived/canceled state, recipient identity, readiness, suppression, unsubscribe, mailbox state, and global delivery state immediately before dispatch.

Terminal sent, suppressed, canceled, permanently failed, ambiguous, and identity-changed outcomes all participate in batch finalization. The dispatcher only runs when the general worker graph and explicit prospect-delivery flag are enabled. Production Gmail dispatch remains unconfigured and all flags default off.

Disposable database integration proved:

- one winner under concurrent claims;
- multi-location conversion and replay idempotency;
- immutable frozen release content;
- ambiguous operations surface attention state;
- post-approval suppression prevents sending and still finalizes;
- the corrected outreach lifecycle requires human contact-readiness review.

## Inbound correspondence and reconciliation

The tested domain service persists receipt identity before provider access, deduplicates namespaced receipts, validates exact mailbox scope, matches by provider thread/RFC references/participants with stored evidence, quarantines unknown/early/ambiguous messages, bounds untrusted bodies and attachment metadata, performs idempotent canonical upsert, limits reply effects to the matched campaign member/follow-ups, folds delivery state monotonically, and commits cursors only after complete page processing. Full-reconciliation and watch-renewal contracts exist.

The production Prisma adapter, authenticated Pub/Sub route, Gmail HTTP/OAuth runtime, daily watch
renewal, 15-minute reconciliation, cursor-expiry fallback, quarantine, and platform failure events
are mounted. These remain fixture-tested/operator-ready rather than live-provider-tested.

## Agent runtime and tools

Prospect tools are mounted through the existing Agent Bridge as `callProspectTool`. A live leased Agent Run provides identity, initiator, capability intersection, explicit `ALL` or reviewed-territory scope, model/provider, prompt/playbook/template version, request/correlation identity, and evidence lineage. Caller-supplied capabilities are not authority.

Mounted low-risk capabilities include scoped prospect search/intelligence, grounded draft creation/revision, and Agent Question creation. Evidence distinguishes `CANONICAL_CRM_DATA` from `UNTRUSTED_EXTERNAL_EVIDENCE`. Drafts store Agent Run/model/prompt/template/evidence lineage.

No tools exist for agent approval, release, send, conversion, merge/delete, suppression restoration, credentials, or delivery activation. Additional requested recommendation/analysis tools remain incomplete beyond these mounted surfaces.

## Import and performance status

Implemented:

- 25 MB raw request limit;
- 150 MB declared expanded-workbook metadata limit;
- 100 sheets, 100,000 rows, 100 columns, 10,000 characters/cell, and 256 KB/row limits;
- inert scalar staging;
- immutable private object upload with signed checksum/size/MIME/generation and version verification;
- server-owned bounded CSV/XLSX parsing, durable BullMQ inspect/stage/commit workers, job/row leases,
  cancellation, observable dashboard progress, and a delivery-independent `crm-only` worker graph;
- persisted reviewed link/update/distinct/skip/quarantine decisions and conservative field updates;
- append-only dry-run report rows, authenticated streamed CSV, and hash identity;
- exact-hash reviewed archive repair that never deletes evidence/history or linked existing records;
- stable composite `updatedAt DESC, id DESC` cursor;
- paginated directory, pipeline, activities, threads/messages, and campaign review surfaces;
- stage totals instead of silent 1,000-row truncation;
- duplicate scanning in 5,000-row chunks beyond 20,000 organizations;
- deterministic real 20,000-row XLSX parser test, 20,001-organization duplicate test, and a PC-local
  MinIO/Postgres end-to-end immutable upload/inspect/stage/report integration test;
- representative 50,000-organization query plans: trigram name search 1.5 ms and indexed 100-row
  composite keyset page 0.23 ms on the disposable local database.

Still required before the real workbook: authenticated staging rehearsal, full 20,000-row object-
storage pipeline measurement, and Tom's review of the real dry-run reconciliation. The real
16,397-row workbook was not accessed or imported.

The real 16,397-row workbook must not be imported yet.

## UI and browser QA

Implemented UI protections include server-owned feature policy, route/API/navigation gates, exact Gmail mailbox selection and health display, exact frozen recipient/content/hash inspection, separate approval/release confirmations, exact count/scope copy, keyboard focus entry, Tab trap, and Escape handling. Core CRM and human prospect outreach are off by default; autonomous and deferred Google features are hard-off.

Component and automated accessibility tests pass. Axe's color-contrast rule is not disabled, but
jsdom logs its missing canvas implementation. In-app browser QA against the local Clerk development
fixture verified desktop and 390 x 844 mobile layouts, directory filters, deep-linked filter state,
URL updates, browser back/forward restoration, outreach readiness, exact frozen recipient/content
inspection, and fail-closed final release. It found and corrected two partial-readiness fixture crashes
(`accounts` and frozen `items` were assumed present). A fresh post-fix browser session rendered the
campaign and outreach views with zero console errors and `Send now` disabled. Real staging auth,
real-route keyboard coverage, and instrumented contrast remain staging gates rather than claimed proof.

## Security, privacy, audit, and operational events

- Strict audit coverage was expanded for contactability, conversion, draft/batch, release, and agent lineage actions.
- Append-only middleware covers stage history, activities, source evidence, suppression events, and email events.
- External email/research/workbook values are treated as bounded untrusted evidence; HTML send/render remains text-first until a reviewed sanitizer exists; attachments are metadata-only.
- Feature flags protect routes, APIs, workers, and schedules, not just CSS/navigation.
- Tenant registry, bypass-boundary, raw-SQL, public-surface, AI-boundary, and client-secret gates pass.
- Platform CRM events use a separate `PlatformOperationalEvent`; tenant `OperationalEvent` remains
  strictly tenant-owned and no sentinel tenant is used. The platform-admin attention console
  merges both streams with separate acknowledgement/resolution actions.

## Verification performed

Successful:

- `pnpm lint`: 13/13 tasks (one pre-existing `<img>` performance warning, no errors).
- `pnpm typecheck`: 23/23 tasks.
- `pnpm build`: 13/13 tasks; only the existing OpenTelemetry dynamic-require warning.
- root script tests: 170 passed, 1 intentional pre-existing skip.
- `pnpm --filter @pathfinder/api test`: 1,165 passed, 57 environment-gated skips.
- full package run: DB 1,106 passed/84 skipped; workers 385/2; jobs 61/8; dashboard 731; web 304; other packages passed.
- timed-out API error-boundary test: 7/7 passed immediately in isolation; then full API suite passed.
- explicit disposable PostgreSQL CRM, outreach, and canonicalization integration suites passed.
- fresh 132-migration chain passed against disposable pgvector PostgreSQL (164 public tables),
  including the final import/report/repair schema and corrected workflow guard.
- populated synthetic upgrade passed from the 127-migration pre-correction schema through all five
  correction migrations with 20,000 CRM records and 1,000 legacy correspondence/send histories;
  it discovered and then proved the corrected legacy provider-event namespace backfill.
- PC-local MinIO/Postgres immutable XLSX upload, checksum/version verification, inspection,
  staging, and append-only report integration passed.
- reviewed import archive repair passed in the disposable CRM lifecycle integration; a stale plan
  hash is rejected and linked pre-existing organizations remain untouched.
- 50,000-row PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)` used the intended trigram and composite cursor
  indexes (about 1.5 ms search and 0.23 ms 100-row page on this PC).
- tenant procedure, tenant registry, tenant bypass, raw SQL, public surface, AI provider/budget, secret, and client-bundle gates passed.
- `pnpm verify:client-bundles`: forced 13/13 production builds and scanned 439 deliverable files across two apps for 13 server-only canaries and hardcoded credential patterns.
- in-app browser QA: directory/outreach/campaign desktop and 390 px mobile, deep links,
  back/forward state, exact frozen content, dark send control, and a clean post-fix console.
- committed staging-reconciled branch based on `69f6e3a`: 23/23 typecheck tasks, 13/13 lint tasks,
  13/13 build tasks, the complete package/root test command, tenant registry, tenant bypass, raw-SQL,
  public-surface, and script gates passed. Reconciliation exposed and corrected one missing
  `next/navigation` accessibility-test mock for URL-backed directory state. One unrelated
  evaluation-panel timing assertion failed during an intermediate heavily concurrent run and
  passed immediately in isolation; the subsequent full repository test command passed.
- changed-file Prettier check and `git diff --check` passed after formatting.
- legacy SQLite Python tests: 6/6; root wrapper: 1/1.
- Gmail/fake provider tests: 8 total; inbound sync tests: 14.

Skipped or unproven:

- routine suites skip credentialed provider integrations by design; the CRM disposable DB suites
  and PC-local immutable object-storage integration were run explicitly.
- no real Gmail/OAuth/Pub/Sub test, because no credentials or external state were authorized.
- no authenticated staging browser run against the real admin routes.
- no real workbook import.
- no sanitized snapshot containing real production data; both fresh-chain and populated synthetic
  pre-correction upgrade rehearsals passed.

## Merge and deployment reconciliation

The original dirty work was preserved in local commit `62e8237` and recovery branch
`codex/torchiko-crm-pre-correction-20260820`. The correction was organized into reviewable commits,
then replayed onto active staging successor `69f6e3a` in branch
`codex/torchiko-crm-staging-reconciled-20260820`. The attention-console conflict was resolved
semantically: staging's expanded support-request states, CRM platform events, and the router
modularity boundary all survive. `packages/db/src/index.ts` retains staging's `notesProposalInput`
export alongside CRM exports. Prisma was regenerated and the committed reconciled tree passed lint,
typecheck, full tests, build, and boundary gates. No merge or push occurred.

Review sequence on the reconciled branch:

- `21e2483` preserve the pre-correction CRM snapshot on staging;
- `1888f0b` source-of-truth ADR and deterministic SQLite migration;
- `681d6a7` canonical CRM schema, migrations, outbox, conversion, and contactability;
- `41a87cf` verified Agent Run prospect tools and lineage;
- `daa85f5` Gmail correspondence/OAuth/Pub/Sub/inbound runtime;
- `387a2a2` recoverable delivery, synchronization, and import workers;
- `1724244` scalable canonical CRM API and platform attention read model;
- `eb740c8` protected CRM dashboard and exact frozen-batch/import surfaces;
- `83ca4e6` architecture and operational handoff documentation;
- `1e7f183` attention-router modularity reconciliation.

Recommended order after blockers are resolved:

1. production-like backup and migration rehearsal;
2. apply migrations;
3. deploy workers with delivery disabled;
4. deploy API/dashboard;
5. verify CRM without provider credentials;
6. run synthetic import and reconciliation;
7. complete authenticated staging browser QA on real admin routes;
8. configure staging Google/Pub/Sub through operator actions;
9. run fixture/replay plus one separately approved internal smoke test;
10. re-disable prospect delivery.

## Remaining blockers by gate

### Blocks merge under this packet

- authenticated staging browser QA on the real admin routes, required by the packet's strict
  definition of done even though local fixture browser QA now passes.

### Blocks staging provider setup

- operator OAuth/Pub/Sub credentials and exact callback/audience configuration;
- live credentialed smoke verification of OAuth refresh, watch, history, and reconciliation;
- authenticated browser verification of provider health and recovery UI.

### Blocks internal email

- every staging-provider item above;
- operator population and inspection of the already enforced internal-recipient allowlist;
- conservative pacing/kill-switch operator verification;
- SPF/DKIM/DMARC review;
- exact human-approved recipient/message;
- real reply/failure/unknown-message smoke reconciliation.

### Blocks real workbook import

- authenticated staging rehearsal of signed upload, cancellation, report download, and repair;
- full 20,000-row object-storage pipeline measurement (the real XLSX parser and smaller end-to-end
  storage pipeline are already proven locally);
- Tom's dry-run review.

### Blocks production outreach

- all internal-email gates;
- legal/privacy/template/retention review;
- opt-out and suppression smoke test;
- live operational-event and provider-failure smoke verification;
- ramp/cap/pause/redrive runbook and a tiny human-reviewed pilot.

### Safe to defer

- Calendar, Meet, Drive, transcripts, and meeting automation;
- Bot Mode and autonomous orchestration/sending;
- customer-facing CRM analytics;
- automatic destructive duplicate merge;
- advanced forecasting/geospatial optimization;
- million-record optimization;
- open/click tracking;
- Resend cold-outreach adapter;
- non-critical saved-view/bulk/UI polish.

## Operator-only actions for Tom

After merge review and authenticated staging are ready:

1. confirm Google Cloud project `winged-precinct-506104-h1`;
2. configure OAuth consent and create the web OAuth client;
3. register exact staging/production redirect URLs;
4. choose the outreach mailbox and least-privilege access model;
5. create Pub/Sub topic/subscription, push service account, IAM, and exact audience;
6. connect the mailbox through Torchiko and inspect watch/reconciliation health;
7. review SPF, DKIM, and DMARC;
8. obtain legal review for sender identity, outreach language, opt-out, privacy, and retention;
9. approve the exact one-recipient internal smoke test;
10. approve the real-workbook dry-run reconciliation;
11. approve the first very small production cohort.

## External-state confirmation

No real email was sent. No Gmail/Resend/provider account, credential, OAuth client, Pub/Sub resource/watch, DNS record, workbook, database outside the disposable local container, deployment, merge, push, or unrelated user state was changed. The only Obsidian mutations were a reviewable proposal in `95 AI Staging` and a corresponding change-log entry; operational truth notes were not silently rewritten.
