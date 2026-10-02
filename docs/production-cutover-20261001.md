# Operator CRM production cutover — 2026-10-01

> **Migration instruction status: RESTRICTED PRODUCTION EXCEPTION — LIVE GATES REQUIRED.**

## Owner scope

On 2026-10-01, Tom requested publication of the operator release in PR #38 and said:

> yeh. do whatever you need to do. i just wanna get everyhting publiushes

Later in the same conversation, Tom reaffirmed:

> The whole goal is to just get it into production, so that way the CRM can actually be, or the AI integration can all be useful. And then we made other changes too, but I just want you to get it into production. You have all the permissions possible.

This authorizes the reviewed operator CRM/business-tool application release and the single additive
migration `20261001100000_crm_receipt_and_execution_foundations`, with staging first and production
only after the gates below. It does not waive a gate or authorize unrelated source changes.
The reviewed release source is the current PR #38 application tree at
`39557745827a2e86a3a76c1f389e05f65d78900c`; this record adds scope and safety documentation only.
The September 30 approval and its 252-to-254 cutover remain unchanged and cannot admit migration 255.
The production incident remains ACTIVE by default; this is a one-time scoped exception.

The approval record cannot contain its own commit SHA. Its final docs-bearing SHA must pass full
exact-head CI and exact three-service staging admission, and production promotion must use that same
admitted source. No different application source may be substituted at promotion.

## Targets and admitted suffix

- Railway project: `8621111a-4ac8-4d88-9566-4627c8a02059`.
- Staging environment: `a7a394fc-aa4e-4a45-bd3c-904419a67818`; database resource
  `7bd81064-588f-48a5-b138-1fc86691a09b`, database `pathfinder_staging`.
- Production environment: `ad140532-61bb-4355-a7e3-ebb2a54d743f`; Supabase project
  `zpacmfkomonxeqdiadtz`.
- Current three-service staging and production application baseline:
  `06e5745473762a18db07c5d30d0f6677c62c6103`. Reconfirm this baseline before the writer drain.
- Reviewed predecessor: 254 finished migrations, 277 public tables; normalized manifest
  `5cd8553c554dc8c728ac44fb3d5f5ace0644560025d7fe4b46e7b2c6af1f9cb0`.
- Reviewed endpoint: 255 finished migrations, 280 public tables; normalized manifest
  `36de18c960796e92e67699fe84958d80a88ba958fbf9b282c88a8236415ae5a0`.
- Preserve all original ledger rows, including production's historical rolled-back duplicate.
  Do not repair, resolve, remove or overwrite ledger history. The existing weekly-digest historical
  checksum is admitted only with its canonical schema fingerprint passing.

## Live gates and order

1. Require `ci`, `visitor-launch` and `railway-iac` green on the final exact head, a clean candidate
   release verification and deterministic staging handoff. A second 60-minute CI timeout stops this
   release; do not change the workflow or treat reported passing tests as a completed check.
2. Freeze that source; pause all three staging autodeploy triggers without deploying. Drain old
   writers and external ingress. Treat current staging data as `preserve-existing`.
3. Capture a fresh post-drain, release-bound staging logical backup outside the database resource.
   Verify its checksum, restore its application public schema into a separately named local disposable
   database on PostgreSQL 17, and rehearse only migration 255. The complete private archive retains
   ownership and privileges; local fixture ownership/ACL remapping must be recorded. A public-schema
   rehearsal does not claim a complete provider-platform restoration. Pre-drain observations or
   archives do not satisfy this gate.
4. Require original-column hashes and counts for every pre-existing table to remain unchanged;
   verify the expected receipt-key backfill separately. Require preserved ledger history, no invalid
   indexes or unvalidated constraints, one policy-state row, and empty admission-counter and arming tables.
5. Arm only the staging web migration opt-in and migration-only hold after these gates. Require the
   verified-held receipt and finite exit 2. This intentionally failed deployment is not application health.
6. Close both migration controls to 0. Release web code-only, then dashboard and dormant workers at
   the frozen source. Require exact-SHA health before each subsequent service and flag-off operator QA.
   Restore ordinary autodeploy settings only after exact three-service admission.
7. Promote the exact healthy staging source through its production PR and CI. Before any production
   database write, independently verify the current production ledger; pause autodeploy, drain writers,
   and capture a fresh post-drain production backup with disposable restore and migration rehearsal.
8. From the frozen reviewed source, the sole admitted production migration entrypoint is the
   repository's existing `@pathfinder/db` `db:migrate:prod` command, with database URLs injected only
   through the existing secret environment. The entrypoint may execute only the reviewed 254-to-255
   suffix after every live gate passes; no other migration command is authorized. Repeat all ledger, schema, original-data preservation and
   backfill checks. Release production web, dashboard and dormant workers in that order at the admitted
   source, requiring health and connectivity proof before reopening normal deployment settings.

## Existing operator connection state

Read-only runtime checks on 2026-10-01 found `OPERATOR_OAUTH_ENABLED=false` on the staging dashboard
and `OPERATOR_OAUTH_ENABLED=true` on the production dashboard. The production dashboard already has
issuer, redirect-origin, user-allowlist and pepper configuration names present; their values were not
read or copied. Preserve that existing production OAuth state after healthy admission. This release
does not create a credential, add an allowed user or redirect origin, or enable a previously off flag.
The campaign-release, customer-create and customer-invite switches remain unset/default off in both.

## Retained limits and recovery

Keep the existing staging hard USD 10 spending ceiling. Use existing access and credentials only;
never print or copy credential values. Existing SSH and logical-backup tools may use authentication
operationally, and backup contents remain private outside the repository and vault.

No seed, reset, restore over production or staging, manual data cleanup, new accounts or credentials,
customer email or invites, money movement, billing activation, new feature-flag activation, or
provider/background execution is authorized. New operator/provider/delivery switches remain off.
New OAuth activation and real-device keyboard acceptance are separate decisions and are not claimed here.

On drift, failed proof, unresolved cancellation, unexpected data change or unhealthy admission, stop.
Retain the additive schema. A compatible application rollback uses the previous admitted application
source after draining writers; no destructive down migration or live restore is automatic.

## Execution evidence

This record grants scope only. It does not establish that CI, backups, rehearsal, staging or production
have completed. Record actual deployment IDs, source SHAs, checks and receipts in the operator journal.
