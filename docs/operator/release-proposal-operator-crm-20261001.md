# Release and rollback proposal: operator CRM and business tools (migration 255)

> **Status: PROPOSAL ONLY. Not approved, not executed.** Nothing in this document deploys, migrates, enables a flag, sends a
> message or creates an account. The 2026-09-30 production approval (`docs/production-cutover-20260930.md`) covers migrations 253 and
> 254 for one exact source tree and does not cover this candidate. Tom must approve this scope separately.

## What this candidate adds on top of the 254 release

One additive migration, `20261001100000_crm_receipt_and_execution_foundations`, and the code that uses it. Every new capability is
behind the existing operator OAuth switch (`OPERATOR_OAUTH_ENABLED`, default off); the paths that touch the outside world have their own
switches that default off.

| Area                          | Tools (all through reviewed proposals unless marked read)                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orientation and recovery      | context, identifier discovery, `get_operation`, plans, cancel and recover controls (read)                                                               |
| CRM upkeep                    | resolve/get account, contacts, notes, duplicates, history (read); create/update/archive contact, follow-up, note, account archive, duplicate resolution |
| Campaigns                     | list/get campaign, drafts, outreach batch (read); create, membership, draft review, stage, approve, release (release queues only and is off by default) |
| Mail                          | mailboxes, threads, messages, receipts, platform quarantine and webhook receipts (read; platform ones need an all-customer connection)                  |
| Support                       | request detail and messages (read); internal note, portal information request, completion, triage                                                       |
| Customers                     | list, onboarding dossier (read); create customer with a draft venue, invite a person, grouped onboarding questions                                      |
| Venues                        | visitor notices: list (read); create, go live, end                                                                                                      |
| Company, reports, billing     | company context, reports and status, billing status and invoices (read)                                                                                 |
| Routines, access, offboarding | routine, membership and offboarding metadata (read)                                                                                                     |

No tool sends email, charges or moves money, deletes data, or changes policy. Customer-facing support steps are portal messages only.

## The migration (additive, forward-only)

- `prospect_activities.external_receipt_key` nullable with a unique index. A backfill gives the earliest operator-logged send per Gmail
  message id a key; duplicates and every other row are untouched. No trigger exists on this table.
- Lease, fence, attempt, preview-digest and policy-revision columns on `operator_proposals` and `operator_plans`; `allowed_kinds` on
  `operator_autonomy_policies`; three new tables (`operator_policy_state` seeded with one row, `operator_admission_counters`,
  `operator_armings`). All `NOT NULL` additions carry constant defaults, so they are metadata-only changes.
- Disposable result: 255 finished migrations, 280 public tables, replay reports nothing pending.
- Expected hosted boundary: from the admitted 254 / 277 ledger to 255 / 280. A 252 ledger takes the reviewed 253 to 255 suffix.

## Switches (set per environment; all default off)

| Switch                              | Effect when true                                                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPERATOR_OAUTH_ENABLED`            | Operator endpoint exists (existing; unchanged)                                                                                                      |
| `OPERATOR_CAMPAIGN_RELEASE_ENABLED` | The release proposal may be created. Delivery still needs the global delivery control, an enabled mailbox and the 1 to 50 recipient canary          |
| `OPERATOR_CUSTOMER_CREATE_ENABLED`  | Approving a create makes an organization at the identity provider. Nobody is invited or emailed                                                     |
| `OPERATOR_CUSTOMER_INVITE_ENABLED`  | Approving an invite has the identity provider email a sign-up link; the person creates their own account and reaches only that customer's dashboard |

Create and invite are separate steps so a customer can exist, be prepared and be reviewed before anyone is emailed.

## Gates before any deploy (in order; none is automatic)

1. Tom approves this scope and the exact source SHA in writing; the 252-to-254 approval is not reused.
2. Exact-head CI green (`ci`, `visitor-launch`, `railway-iac`) on the final SHA.
3. Staging first, following `docs/staging-release-workflow.md`: pause autodeploy, freeze the SHA, drain writers, release-bound backup
   and restore proof, held migration (`PATHFINDER_STAGING_MIGRATION_ONLY_HOLD=1`), then code-only web, then dashboard and workers.
   The staging image approval name is `torchiko-staging-lineage-to-255-20261001`; it names a target and grants nothing.
4. Production only for the healthy exact staging SHA, after the incident stop is lifted and a production-specific approval and fresh
   post-drain backup exist.
5. After release, leave every new switch off until the operator surface is healthy, then turn them on one at a time.

## Rollback

- **Application:** redeploy the previous application revision. The previous code ignores the new columns and tables, so the schema
  can stay. Nothing in the previous release reads `external_receipt_key`, the lease columns or the new tables.
- **Switches:** set the three new switches and `OPERATOR_OAUTH_ENABLED` to `false`; every operator path then answers 404 or refuses.
- **Database:** the migration is additive; do not drop columns or tables during an incident. If the migration itself fails it runs in one
  transaction and leaves the ledger unchanged. Restoring the pre-migration backup is the last resort and only with Tom's approval.
- **Data written through the new tools** (notices, campaign drafts, support notes) is ordinary canonical data and is reversed through
  the same canonical actions or the revert proposal where one exists. A created customer organization is not deleted automatically;
  suspend the customer in the admin app and handle the provider organization by hand.

## Evidence so far, and what is NOT RUN

- PASS locally on a disposable database: operator suite 26 files / 268 tests (serial), contracts 636, repository typecheck 27/27, the
  migration and release script suites, and the raw-SQL, tenant and public-surface verifiers. See the journal.
- NOT RUN: any staging or production deployment or migration; any real identity-provider call (proof uses a fake provider); real mailbox
  delivery; real iPhone keyboard proof (`torchiko-keyboard-device-protocol.md`); full `pnpm test`; browser and visual suites;
  client-bundle-secrets verifier; hosted authenticated inspection.

## Decisions only Tom can make

1. Approve or amend this release scope and bind it to a source SHA.
2. Whether `OPERATOR_CUSTOMER_CREATE_ENABLED` and `OPERATOR_CUSTOMER_INVITE_ENABLED` are turned on, and when.
3. The iPhone keyboard evidence, which is the only way to call that fix done.
4. H11 and whether lossless CRM merge is wanted (it needs a reversible-ledger design first).
