# External database incident stop

> **Production incident state: ACTIVE. Staging exception state: APPROVED.**

## Restricted guest grounding correction — approved 2026-10-10

Tom's later continued-release instruction authorizes the [code-only correction record](production-guide-grounding-20261010.md)
for candidate `f1b12684b5ce0d96208a6d361ec4d65a32390dce` and tree
`998c3e2fe40f85dfa21c05155f8dfbf8e16bc555`. The final documentation-bearing SHA requires
full exact-head CI, staging three-service admission, protected promotion, production health and
visitor acceptance. The incident remains ACTIVE; no hosted database migration, data repair,
package mutation, provider flag change, customer send, or deletion is admitted.

## Restricted guide context fidelity release — approved 2026-10-10

Tom directly authorized the code-only guide context fidelity release on October 10, 2026.
The [release-specific record](production-cutover-20261010.md) binds the reviewed application
candidate `483e6ac9f5d30d9076b17149bd38014f60e9d9eb` and its source tree
`c3b40b11dea1b7922d0756e65eb522ecaed1608e` to the unchanged production base
`bfd0a8e427e44dce46219084e8ab5fefc728fdfe`. Its final documentation-bearing SHA must
pass exact-head CI and three-service staging admission before production promotion. The
production incident remains ACTIVE by default. This exception admits no hosted database
migration, data repair, seed, reset, restore, worker flag change, customer send, or deletion.

The September 27 distribution and appearance source endpoint is 252 migrations. Source admission
does not extend either hosted exception. The recorded staging exception below is synthetic-only,
while the current staging database may contain restored production lineage; treat that database as
preserved data until its lineage is independently resolved and Tom explicitly authorizes the
preserved-data staging policy for this exact release. The September 22 production exception covers
the reviewed 110-to-250 cutover, not migrations 251–252. Keep both hosted migrations and production
promotion held until their respective release-specific gates are satisfied.

## Restricted production cutover exception — approved 2026-09-22

At `2026-09-22T20:21:17Z`, Tom explicitly approved the reviewed PathFinder V2 production
cutover plan for Supabase project `zpacmfkomonxeqdiadtz`. The approved plan's SHA-256 is
`210bac2872449ad19af4b3de65d473520e5d99177c77bfadf92b573d4be9e7ac`.
See [the scoped approval record](production-cutover-20260922.md). This exception supersedes the
historical no-production statements below only for the exact reads, backup/rehearsal, controlled
writer drain, pending-migration roll-forward, configuration, and release promotion in that plan.

The production incident remains ACTIVE by default. This is not a blanket incident resolution.
Live writes stay gated on green exact-SHA CI, exact three-service staging admission, a matching
current production ledger, a fresh verified backup and disposable restoration/upgrade rehearsal,
and all approved stop conditions. No seed, reset, restore over production, manual data cleanup,
customer email, billing activation, or background/provider execution is authorized.

## Restricted production cutover exception — approved 2026-09-30

On 2026-09-30, Tom gave the following explicit production instruction:

> So how can you get it the update. That was the whole point of this to get all the features we made live

This approves carrying the combined Release B/operator/Safari candidate through the narrowly scoped
252-to-254 production cutover, subject to every gate in
[the release-specific approval record](production-cutover-20260930.md). The approval binds the staged
candidate commit `3ae05f50a864807dc02276a117cbff3a0bcd36cf` and its exact source tree, represented by
[production promotion PR #36](https://github.com/tomschoenekase-dotcom/pathfinder/pull/36). It authorizes
only the two named migrations and the application release described in that record. It does not
approve unrelated source changes or waive any stop condition. The owner's review-plan digest is
`78981a2d5bb0423b3ff9440f79f48757572afeb03229287a7b17fa7a0b1655fb`.

The record's source SHA cannot be its own approval prerequisite. Once this exception and its static
safety test are included in the release source, that final docs-bearing SHA must pass full CI and exact
three-service staging admission before promotion. The promotion must use that same admitted SHA.

The incident state remains ACTIVE by default. This is a separate one-time exception; the September 22
110-to-250 approval remains historical and unchanged. All unrelated bans remain in force: no seed,
reset, restore over production, manual data cleanup, customer sends, billing activation, or
provider/background execution. The current exception authorizes no production write until the fresh
post-drain backup/rehearsal and every other release gate pass.

## Restricted operator production cutover exception — approved 2026-10-01

On 2026-10-01, Tom requested publication of PR #38 and reaffirmed:

> The whole goal is to just get it into production, so that way the CRM can actually be, or the AI integration can all be useful. And then we made other changes too, but I just want you to get it into production. You have all the permissions possible.

The [October 1 release record](production-cutover-20261001.md) limits that instruction to the reviewed
PR #38 application tree at `39557745827a2e86a3a76c1f389e05f65d78900c`, its release documentation and
the single additive migration `20261001100000_crm_receipt_and_execution_foundations`. It identifies
staging database `7bd81064-588f-48a5-b138-1fc86691a09b` and production project `zpacmfkomonxeqdiadtz`.
The September 30 record remains unchanged and does not admit this new 254-to-255 suffix.

The incident state remains ACTIVE by default. The final docs-bearing SHA requires green exact-head
CI, clean candidate verification and exact three-service staging admission. Each live write remains
held until its fresh post-drain backup, disposable restore/rehearsal, ledger and original-data
preservation gates pass. Existing production operator OAuth may remain enabled; no new feature-flag
activation, account, credential, customer email, invite, money movement or provider/background
execution is admitted. No seed, reset, restore over production or staging, or manual data cleanup.

## Restricted PR40 production cutover exception — approved 2026-10-03

On October 3, the owner explicitly authorized completing PR #40 through staging and protected
production promotion, including exact-head CI repair and admission of only migrations 256–267.
The [October 3 release record](production-cutover-20261003.md) binds this scope to the final tested
source and preserves the existing 255-migration predecessor and every earlier freeze and refusal.

The incident remains ACTIVE by default. This exception admits no hosted write before exact-head
CI, staging admission, fresh post-drain backups, disposable restoration and migration rehearsal,
ledger integrity and original-column preservation checks pass. Production uses only the existing
production migration entrypoint. Existing provider flags and OAuth state stay unchanged; no sends,
invites, billing actions, account changes, seed, reset, destructive rollback or credential copying.
The prior release exceptions remain historical and unchanged.

## Historical incident and staging exception

On 2026-08-19, Tom approved a staging-only Railway release with a hard USD 10 spending ceiling.
The exception permits writes only to a separately identified, synthetic-only staging database and
staging-only storage. It permits the reviewed migration wrapper, application deployment, and
synthetic QA described in `railway-staging.md`. It does not authorize any production inspection,
write, migration, restore, seed, credential reuse, customer email, or provider-enabled worker.

An earlier command unintentionally applied pending Prisma migrations through an externally
configured Supabase connection. Tom has since identified the affected project and authorized a
bounded read-only assessment. That assessment found a clean 52-migration production ledger with no
failed rows or checksum divergence. Tom then authorized a password-prompted logical backup and an
isolated PostgreSQL 17.6 production-lineage rehearsal. The verified backup exists outside the
repository, and its separate local recovery restore passed, but the project has no provider backup
or PITR. No production database write, migration, seed, rollback, or remediation command may run;
production inspection remains limited to the completed authorized assessment.

The production stop supersedes every migration or seed instruction in older PathFinder plans,
handoffs, backlogs, and runbooks. Historical documents remain useful design evidence, but they are
not operator authority. Do not infer safety from an environment label, a familiar hostname, or an
old instruction. The staging exception exists only through the fail-closed wrapper and exact
resource confirmations in the active Railway runbook.

Local destructive verification remains permitted only through the repository's disposable-only
wrapper against an exact-name `pathfinder_disposable_*` database on exact loopback, with no tunnel
or proxy. That local contract is documented in `docs/railway-staging.md`; it is not an escape hatch
for any external host.

## Staging-only exception controls

The staging exception is narrower than resolving the production incident:

1. `RAILWAY_ENVIRONMENT` must be exactly `staging`, the provider release SHA must equal the
   separately recorded 40-character release SHA, and the database resource identity must equal the
   operator-confirmed staging identity.
2. Pooled and direct database hosts plus the database name must match separate confirmation values.
   The known production project reference is explicitly denied.
3. The data policy is `synthetic-only`; restoring or copying production lineage is not authorized.
4. The reviewed staging migration wrapper is the only active external migration entrypoint. It
   defaults to refusal and requires an explicit one-run opt-in.
5. Workers remain provider-disabled with zero queues. Clerk, storage, Redis, and database resources
   must be staging-only. The release stops before total new monthly staging spend exceeds USD 10.
6. Every deployed application service uses the same immutable release SHA. Production branches,
   resources, variables, and services remain untouched.

## Conditions for lifting the production stop

As of 2026-08-13, Tom identified Supabase ref `zpacmfkomonxeqdiadtz` and authorized the bounded
read-only assessment. The dashboard identifies organization `PathFinder` and project display name
`tomschoenekase-dotcom's Project`. Conditions 1 and 2 below are satisfied. The assessment established
the ledger and relevant schema state. A verified logical backup and production-lineage rehearsal
are now complete, but the Free-plan project has neither scheduled backups nor PITR. The rehearsal
also required a repair for legacy `venue.updated` analytics events. At that historical point,
condition 3 remained unsatisfied. Tom's later September 30 approval satisfies explicit approval only
for migrations 253–254 and the bound application source; the global production stop remains active.

1. Tom identifies the affected external project/environment.
2. Tom authorizes a bounded read-only assessment plan.
3. The resulting evidence establishes migration state, affected schema, and backup/recovery
   posture, and Tom explicitly approves the remediation, roll-forward, or rollback plan plus every
   external database inspection or write that plan authorizes.
4. Only after that explicit production approval, this file, the guarded documents, and the static
   safety test are updated together in one reviewed production stop-lifting commit.

Until all four conditions for global incident resolution are met, the incident remains `ACTIVE`.
The September 30 release-specific record is a narrow exception only; outside its exact scope and live
gates, production instructions must stay absent from active runbooks.
