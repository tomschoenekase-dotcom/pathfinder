# Prospect CRM architecture

Status: correction implementation in progress on `codex/torchiko-crm-foundation-20260819`
Migrations: `20260819213000_add_prospect_crm_foundation`, `20260820021500_add_prospect_outreach_operations`, `20260820150000_canonicalize_prospect_crm`

## Authority and boundaries

Postgres is the only intended writable operational authority. The legacy SQLite Outreach ledger is a read-only migration source after reconciliation; Obsidian retains strategy, playbooks, templates, and decisions rather than mutable CRM truth.

Prospect organizations are platform-owned. Live `Tenant` and `Venue` data remains tenant-owned. Exact-tenant customer relationships and location conversions bridge the two scopes. Calendar, Meet, Drive, autonomous outreach, attachment downloads, and real delivery are off or deferred.

## Canonical ownership

| Record                                                               | Canonical responsibility                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ProspectOrganization` / `ProspectVenue`                             | Organization and physical-location identity, territory, fit, provenance, archive state             |
| `ProspectTag` / `ProspectOrganizationTag`                            | Normalized platform tags                                                                           |
| `ProspectContact`                                                    | Person/address identity, verification readiness, permission uncertainty and current contactability |
| `ProspectContactSuppressionEvent`                                    | Append-only suppression, bounce, complaint, unsubscribe and restoration history                    |
| `ProspectOpportunity`                                                | Stage, owner, priority, next action/due date and won/lost/parked reasoning                         |
| `ProspectStageHistory`, `ProspectActivity`, `ProspectSourceEvidence` | Append-only relationship and provenance ledger                                                     |
| import and duplicate models                                          | Dry-run rows, provenance, conservative duplicate review and commit results                         |
| `ProspectCustomerRelationship`                                       | Organization-to-customer relationship generation                                                   |
| `ProspectLocationConversion`                                         | Historical prospect-location to live-venue link for an exact tenant                                |
| campaign/draft/batch models                                          | Exact cohorts, versioned drafts, human approval and immutable frozen content                       |
| provider/thread/message/event models                                 | Provider-neutral correspondence with provider/account namespacing                                  |
| `ProspectSendOutbox`                                                 | Atomic release intent, exclusive lease, retry/terminal/ambiguous state                             |

Legacy organization owner/priority, venue stage/priority/next-action, and JSON tag fields are compatibility projections only. Database triggers reject writes to deprecated workflow projections. `ProspectOpportunity` is the sole workflow writer.

## Communications and agents

Gmail is the only permitted prospect correspondence provider. CRM code targets `CorrespondenceProvider`; Resend remains separate for transactional or opted-in product mail. The adapter, fake, normalization, inbound reconciliation contracts, outbox and worker are fixture-tested. Production OAuth composition, Prisma inbound adapter, authenticated Pub/Sub route, watch/reconciliation scheduler, and live smoke test are not complete. Delivery defaults off in environment, feature policy, database global control, mailbox control, campaign control, and provider composition.

Agent tools are mounted on the authenticated Agent Bridge. Capabilities and prospect scope are derived from a live leased Agent Run. Agents can read scoped intelligence, create grounded drafts, and ask the operator; they cannot approve, release, send, convert, unsuppress, merge, delete, or activate delivery.

## Scale and security

Directory/pipeline reads use stable composite cursors. Activities, messages, threads, and campaign members are paginated. Search migrations add `pg_trgm` indexes and duplicate scans are chunked beyond 20,000 organizations. External websites, workbook cells, and email bodies are bounded untrusted evidence, never authorization or agent instructions. HTML sending is disabled until a reviewed sanitizer exists; attachments remain metadata-only.

The import commit is worker-driven, but the real workbook remains blocked by the gaps in `CRM_IMPORT_SCALE_STATUS.md`. Platform CRM events also cannot safely enter the tenant-only `OperationalEvent` model; no sentinel tenant is used. See `CRM_OPERATIONAL_EVENTS_LIMITATION.md`.
